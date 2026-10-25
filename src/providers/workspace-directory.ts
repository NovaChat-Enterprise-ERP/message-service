import type { MemberDto } from '@novachat-enterprise-erp/contracts';
import type { InternalHttpClient } from '@novachat-enterprise-erp/common';

export interface WorkspaceDirectory {
  activeUserIds(workspaceId: string, userIds: string[]): Promise<string[]>;
}

export class WorkspaceServiceDirectory implements WorkspaceDirectory {
  constructor(private readonly client: InternalHttpClient) {}

  async activeUserIds(workspaceId: string, userIds: string[]): Promise<string[]> {
    if (userIds.length === 0) return [];
    const result = await this.client.request<{ items: MemberDto[] }>(`/internal/workspaces/${workspaceId}/members/batch`, {
      method: 'POST',
      body: { userIds: [...new Set(userIds)] },
    });
    return (result?.items ?? []).filter((m) => !m.deactivatedAt).map((m) => m.userId);
  }
}
