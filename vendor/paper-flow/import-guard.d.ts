export function createImportGuard<T>(workspace: T): {
  observe(next: T): void;
  invalidate(): void;
  begin(): { generation: number; workspace: T };
  accepts(ticket: { generation: number; workspace: T }): boolean;
  activate(): void;
  dispose(): void;
};
