import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { EVENTS, type ConversationDto, type MessageDto } from '@novachat-enterprise-erp/contracts';
import { asService } from '@novachat-enterprise-erp/testing';
import { OTHER_WS, WS, createHarness } from './test/harness.js';
import { toTsQuery } from './services/message.service.js';

let h: Awaited<ReturnType<typeof createHarness>>;
const base = `/api/v1/workspaces/${WS}`;
let general: ConversationDto;

const send = (userId: string, conversationId: string, text: string, extra: Record<string, unknown> = {}) =>
  request(h.app).post(`${base}/conversations/${conversationId}/messages`).set(h.as(userId)).send({ text, ...extra });

const mine = async (userId: string) =>
  (await request(h.app).get(`${base}/conversations`).set(h.as(userId))).body.items as ConversationDto[];

beforeAll(async () => {
  h = await createHarness();
  await h.container.services.conversations.provisionWorkspace(WS, 'owner');
  for (const user of ['ada', 'grace', 'linus', 'gus']) await h.container.services.conversations.onMemberJoined(WS, user);
  general = (await mine('owner')).find((c) => c.name === 'general')!;
});

afterAll(() => h.close());

describe('workspace provisioning', () => {
  it('creates #general and #random and adds joiners', async () => {
    const names = (await mine('ada')).map((c) => c.name).sort();
    expect(names).toEqual(['general', 'random']);
    expect(general.isDefault).toBe(true);
    expect(h.events.ofType(EVENTS.CONVERSATION_MEMBER_ADDED).length).toBeGreaterThan(0);
  });

  it('is idempotent', async () => {
    await h.container.services.conversations.provisionWorkspace(WS, 'owner');
    expect((await mine('owner')).filter((c) => c.name === 'general')).toHaveLength(1);
  });
});

describe('channels', () => {
  let course: ConversationDto;

  it('creates public channels with unique names', async () => {
    const res = await request(h.app).post(`${base}/conversations/channels`).set(h.as('ada')).send({ name: 'Course-101' });
    expect(res.status).toBe(201);
    course = res.body;
    expect(course).toMatchObject({ name: 'course-101', type: 'public_channel', memberCount: 1 });
    const dup = await request(h.app).post(`${base}/conversations/channels`).set(h.as('grace')).send({ name: 'course-101' });
    expect(dup.status).toBe(409);
  });

  it('lets members browse and join public channels; guests cannot', async () => {
    const browse = await request(h.app).get(`${base}/conversations/browse`).set(h.as('grace'));
    expect(browse.body.items.map((c: ConversationDto) => c.name)).toContain('course-101');
    const joined = await request(h.app).post(`${base}/conversations/${course.id}/join`).set(h.as('grace'));
    expect(joined.body.memberCount).toBe(2);
    expect((await request(h.app).get(`${base}/conversations/browse`).set(h.as('gus'))).status).toBe(403);
    expect((await request(h.app).post(`${base}/conversations/${course.id}/join`).set(h.as('gus'))).status).toBe(404);
  });

  it('hides private channels from non-members', async () => {
    const res = await request(h.app)
      .post(`${base}/conversations/channels`)
      .set(h.as('ada'))
      .send({ name: 'staff', isPrivate: true, memberUserIds: ['grace', 'not-a-member'] });
    expect(res.body.memberCount).toBe(2);
    expect((await request(h.app).get(`${base}/conversations/${res.body.id}`).set(h.as('linus'))).status).toBe(404);
    expect((await request(h.app).post(`${base}/conversations/${res.body.id}/join`).set(h.as('linus'))).status).toBe(404);
    const browse = await request(h.app).get(`${base}/conversations/browse`).set(h.as('linus'));
    expect(browse.body.items.map((c: ConversationDto) => c.name)).not.toContain('staff');
  });

  it('only lets the creator or admins manage a channel', async () => {
    expect((await request(h.app).patch(`${base}/conversations/${course.id}`).set(h.as('grace')).send({ topic: 'x' })).status).toBe(403);
    const updated = await request(h.app).patch(`${base}/conversations/${course.id}`).set(h.as('ada')).send({ topic: 'Week 1' });
    expect(updated.body.topic).toBe('Week 1');
    const archived = await request(h.app).post(`${base}/conversations/${course.id}/archive`).set(h.as('owner'));
    expect(archived.body.archivedAt).not.toBeNull();
    expect((await send('ada', course.id, 'hello?')).status).toBe(403);
    await request(h.app).post(`${base}/conversations/${course.id}/unarchive`).set(h.as('owner')).expect(200);
  });

  it('protects default channels', async () => {
    expect((await request(h.app).post(`${base}/conversations/${general.id}/leave`).set(h.as('ada'))).status).toBe(400);
    expect((await request(h.app).post(`${base}/conversations/${general.id}/archive`).set(h.as('owner'))).status).toBe(400);
  });

  it('rejects cross-workspace access', async () => {
    const res = await request(h.app).get(`/api/v1/workspaces/${OTHER_WS}/conversations/${general.id}`).set(h.as('ada', OTHER_WS));
    expect(res.status).toBe(404);
  });
});

describe('direct messages', () => {
  it('finds or creates DMs and group DMs', async () => {
    const dm = await request(h.app).post(`${base}/conversations/direct`).set(h.as('ada')).send({ userIds: ['grace'] });
    expect(dm.body).toMatchObject({ type: 'dm', participantIds: ['ada', 'grace'] });
    const again = await request(h.app).post(`${base}/conversations/direct`).set(h.as('grace')).send({ userIds: ['ada'] });
    expect(again.body.id).toBe(dm.body.id);
    const group = await request(h.app).post(`${base}/conversations/direct`).set(h.as('ada')).send({ userIds: ['grace', 'linus'] });
    expect(group.body.type).toBe('group_dm');
    expect((await request(h.app).get(`${base}/conversations/${dm.body.id}`).set(h.as('linus'))).status).toBe(404);
  });

  it('rejects people outside the workspace', async () => {
    const res = await request(h.app).post(`${base}/conversations/direct`).set(h.as('ada')).send({ userIds: ['stranger'] });
    expect(res.status).toBe(400);
  });
});

describe('messages', () => {
  let first: MessageDto;

  it('sends messages idempotently and tracks unread', async () => {
    const res = await send('ada', general.id, 'Hello everyone, welcome to the bootcamp', { clientMsgId: 'c1', mentions: ['grace'] });
    expect(res.status).toBe(201);
    first = res.body;
    const dup = await send('ada', general.id, 'Hello everyone, welcome to the bootcamp', { clientMsgId: 'c1' });
    expect(dup.body.id).toBe(first.id);

    const graceGeneral = (await mine('grace')).find((c) => c.id === general.id)!;
    expect(graceGeneral.membership).toMatchObject({ unreadCount: 1, mentionCount: 1 });
    const adaGeneral = (await mine('ada')).find((c) => c.id === general.id)!;
    expect(adaGeneral.membership?.unreadCount).toBe(0);

    await request(h.app).post(`${base}/conversations/${general.id}/read`).set(h.as('grace')).send({}).expect(204);
    expect((await mine('grace')).find((c) => c.id === general.id)!.membership?.unreadCount).toBe(0);

    const created = h.events.ofType<{ message: MessageDto }>(EVENTS.MESSAGE_CREATED).at(-1)!;
    expect(created.data.message.mentions).toEqual(['grace']);
  });

  it('rejects empty messages and non-members', async () => {
    expect((await send('ada', general.id, '   ')).status).toBe(422);
    const staff = (await mine('ada')).find((c) => c.name === 'staff')!;
    expect((await send('linus', staff.id, 'let me in')).status).toBe(404);
  });

  it('paginates newest first', async () => {
    for (let i = 0; i < 5; i++) await send('grace', general.id, `message ${i}`);
    const page1 = await request(h.app).get(`${base}/conversations/${general.id}/messages?limit=3`).set(h.as('ada'));
    expect(page1.body.items.map((m: MessageDto) => m.text)).toEqual(['message 4', 'message 3', 'message 2']);
    const page2 = await request(h.app)
      .get(`${base}/conversations/${general.id}/messages?limit=3&cursor=${page1.body.nextCursor}`)
      .set(h.as('ada'));
    expect(page2.body.items.map((m: MessageDto) => m.text)).toEqual(['message 1', 'message 0', first.text]);
    expect(page2.body.nextCursor).toBeNull();
  });

  it('supports threads and the threads view', async () => {
    const reply = await send('grace', general.id, 'Thanks Ada!', { parentId: first.id });
    expect(reply.body.parentId).toBe(first.id);
    await send('linus', general.id, 'Glad to be here', { parentId: first.id });
    const root = await request(h.app).get(`${base}/messages/${first.id}`).set(h.as('ada'));
    expect(root.body).toMatchObject({ replyCount: 2, replyUserIds: ['grace', 'linus'] });
    const replies = await request(h.app).get(`${base}/messages/${first.id}/replies`).set(h.as('ada'));
    expect(replies.body.items.map((m: MessageDto) => m.text)).toEqual(['Thanks Ada!', 'Glad to be here']);
    const threads = await request(h.app).get(`${base}/threads`).set(h.as('grace'));
    expect(threads.body.items[0].root.id).toBe(first.id);
    expect((await send('ada', general.id, 'nested', { parentId: reply.body.id })).status).toBe(400);
  });

  it('edits and deletes with ownership rules', async () => {
    const msg = (await send('linus', general.id, 'tpyo')).body as MessageDto;
    expect((await request(h.app).patch(`${base}/messages/${msg.id}`).set(h.as('ada')).send({ text: 'x' })).status).toBe(403);
    const edited = await request(h.app).patch(`${base}/messages/${msg.id}`).set(h.as('linus')).send({ text: 'typo' });
    expect(edited.body).toMatchObject({ text: 'typo' });
    expect(edited.body.editedAt).not.toBeNull();
    expect((await request(h.app).delete(`${base}/messages/${msg.id}`).set(h.as('ada'))).status).toBe(403);
    await request(h.app).delete(`${base}/messages/${msg.id}`).set(h.as('owner')).expect(204);
    const after = await request(h.app).get(`${base}/messages/${msg.id}`).set(h.as('ada'));
    expect(after.body).toMatchObject({ text: '', deletedAt: expect.any(String) });
  });

  it('aggregates reactions and pins', async () => {
    await request(h.app).post(`${base}/messages/${first.id}/reactions`).set(h.as('grace')).send({ emoji: '🎉' });
    const res = await request(h.app).post(`${base}/messages/${first.id}/reactions`).set(h.as('linus')).send({ emoji: '🎉' });
    expect(res.body.reactions).toEqual([{ emoji: '🎉', count: 2, userIds: ['grace', 'linus'] }]);
    const removed = await request(h.app).delete(`${base}/messages/${first.id}/reactions/${encodeURIComponent('🎉')}`).set(h.as('grace'));
    expect(removed.body.reactions[0].count).toBe(1);

    await request(h.app).post(`${base}/messages/${first.id}/pin`).set(h.as('grace')).expect(200);
    const pins = await request(h.app).get(`${base}/conversations/${general.id}/pins`).set(h.as('ada'));
    expect(pins.body.items.map((m: MessageDto) => m.id)).toEqual([first.id]);
  });

  it('searches with prefix matching only within my conversations', async () => {
    const staff = (await mine('ada')).find((c) => c.name === 'staff')!;
    await send('ada', staff.id, 'secret bootstrap plan');
    const ada = await request(h.app).get(`${base}/search?q=boot`).set(h.as('ada'));
    expect(ada.body.items.map((r: { message: MessageDto }) => r.message.text)).toEqual(
      expect.arrayContaining(['secret bootstrap plan', 'Hello everyone, welcome to the bootcamp']),
    );
    expect(ada.body.items[0].highlight).toContain('<mark>');
    const linus = await request(h.app).get(`${base}/search?q=bootstrap`).set(h.as('linus'));
    expect(linus.body.items).toHaveLength(0);
  });

  it('builds safe prefix queries', () => {
    expect(toTsQuery("Hello, wor'ld & | !")).toBe('hello:* & world:*');
    expect(toTsQuery('&&&')).toBeNull();
  });
});

describe('internal api', () => {
  it('reports access and member lists', async () => {
    const res = await request(h.app).get(`/internal/conversations/${general.id}/access/grace?includeMembers=true`).set(asService());
    expect(res.body).toMatchObject({ isMember: true, type: 'public_channel', workspaceId: WS });
    expect(res.body.memberUserIds).toContain('linus');
  });

  it('posts system messages', async () => {
    const res = await request(h.app)
      .post(`/internal/conversations/${general.id}/system-messages`)
      .set(asService('call-service'))
      .send({ authorId: 'ada', text: 'Ada started a call' });
    expect(res.body.kind).toBe('system');
  });

  it('removes departed members from channels but not DMs', async () => {
    await h.container.services.conversations.onMemberRemoved(WS, 'linus');
    const remaining = await request(h.app).get(`/internal/workspaces/${WS}/users/linus/conversations`).set(asService());
    expect(remaining.body.items).toHaveLength(1);
  });
});
