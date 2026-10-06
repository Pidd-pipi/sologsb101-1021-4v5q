/**
 * 借展锁定守卫
 * 借出期间印稿、工序、钤印记录、印谱条目只读；各 store 写入口统一调用本守卫。
 * 借展事务（$lib/utils/loan）直接走 Dexie 事务加 / 解锁，不经过这些守卫。
 */
export interface Lockable {
  loanLocked?: boolean;
}

/** 旧档案缺 loanLocked 字段时按未借出（false）兼容 */
export function isLocked(entity: Lockable | undefined | null): boolean {
  return entity?.loanLocked === true;
}

/** 印石 / 印稿维度写操作守卫 */
export function assertUnlocked(entity: Lockable | undefined | null, label: string): void {
  if (isLocked(entity)) throw new Error(`${label}随印石借展中，归还核还前为只读`);
}
