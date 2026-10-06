<script lang="ts">
  /**
   * /loans 借展点交
   * 从已收录未借出的印石选一批出库，登记借展方、归还日与印谱快照，整批进入借出；
   * 归还时逐方核对并记录缺损与养护结论，异常先列入待处理；任一写入失败整批恢复，可从原清单重试。
   * 多标签并发点交时，后提交批次会被拒绝（不覆盖先完成的借出）。
   * 消费 Stone、Catalog、Design、Impression、LoanBatch、LoanItem。
   */
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import EmptyPanel from '$lib/components/common/EmptyPanel.svelte';
  import StatBadge from '$lib/components/common/StatBadge.svelte';
  import { useIdbTable } from '$lib/hooks/useIdbTable';
  import { stones } from '$lib/stores/stoneStore';
  import { designs } from '$lib/stores/designStore';
  import { impressions } from '$lib/stores/impressionStore';
  import {
    activeBatches,
    createLoanBatch,
    loadLoans,
    loanItems,
    LoanConflictError,
    pendingItems,
    resolveLoanItem,
    returnLoanItems,
    returnedBatches,
  } from '$lib/stores/loanStore';
  import {
    LOAN_BATCH_STATUS_COLOR,
    LOAN_BATCH_STATUS_LABEL,
    LOAN_ITEM_STATUS_COLOR,
    LOAN_ITEM_STATUS_LABEL,
    MAINTENANCE_TEMPLATE_OPTIONS,
    parseSnapshot,
    type LoanBatch,
    type LoanItem,
  } from '$lib/types/loan';
  import type { Catalog } from '$lib/types/catalog';
  import type { Design } from '$lib/types/design';
  import type { Impression } from '$lib/types/impression';
  import type { Stone } from '$lib/types/stone';
  import { GRADE_WEIGHT } from '$lib/types/impression';
  import { STONE_TYPE_LABEL } from '$lib/types/stone';

  const catalogTable = useIdbTable<Catalog>((database) => database.catalogs, { sortByUpdatedAt: false });
  const catalogRows = catalogTable.rows;

  onMount(() => {
    void loadLoans();
  });

  /* ------------------------------ 可借印石（已收录 · 未借出） ------------------------------ */

  interface EligibleStone {
    stone: Stone;
    catalog: Catalog;
    design: Design | undefined;
    best: Impression | undefined;
  }

  const eligibleStones = $derived<EligibleStone[]>(
    $stones
      .filter((stone) => !stone.lentOut)
      .map((stone): EligibleStone | null => {
        const catalog = $catalogRows.find((item) => item.stoneId === stone.id && item.included === 'included');
        if (!catalog) return null;
        const design = $designs
          .filter((item) => item.stoneId === stone.id)
          .sort((a, b) => Number(b.adopted) - Number(a.adopted))[0];
        const best = design
          ? $impressions
              .filter((item) => item.designId === design.id)
              .sort((a, b) => GRADE_WEIGHT[b.grade] - GRADE_WEIGHT[a.grade])[0]
          : undefined;
        return { stone, catalog, design, best };
      })
      .filter((item): item is EligibleStone => item !== null),
  );

  /* ------------------------------ 批次与条目 ------------------------------ */

  const activeWithItems = $derived(
    $activeBatches.map((batch) => ({
      batch,
      items: loanItemsOfBatch(batch.id),
    })),
  );

  const returnedWithItems = $derived(
    $returnedBatches.map((batch) => ({
      batch,
      items: loanItemsOfBatch(batch.id),
    })),
  );

  function loanItemsOfBatch(batchId: string): LoanItem[] {
    return get(loanItems).filter((item) => item.batchId === batchId);
  }

  const pendingWithRefs = $derived(
    $pendingItems.map((item) => ({
      item,
      batch: $activeBatches.find((batch) => batch.id === item.batchId),
      stone: $stones.find((stone) => stone.id === item.stoneId),
    })),
  );

  const stat = $derived({
    eligible: eligibleStones.length,
    lent: $stones.filter((stone) => stone.lentOut).length,
    active: $activeBatches.length,
    pending: $pendingItems.length,
    returned: $returnedBatches.length,
  });

  /* ------------------------------ 点交出库表单 ------------------------------ */

  let selectedIds = $state<string[]>([]);
  let borrower = $state('');
  let eventName = $state('');
  let expectedReturnDate = $state(defaultReturnDate());
  let note = $state('');
  let submitting = $state(false);
  let formError = $state('');
  let formToast = $state('');

  function defaultReturnDate(): string {
    const date = new Date(Date.now() + 30 * 86400000);
    return date.toISOString().slice(0, 10);
  }

  function toggleSelect(stoneId: string): void {
    selectedIds = selectedIds.includes(stoneId)
      ? selectedIds.filter((id) => id !== stoneId)
      : [...selectedIds, stoneId];
  }

  function selectAll(): void {
    selectedIds =
      selectedIds.length === eligibleStones.length ? [] : eligibleStones.map((item) => item.stone.id);
  }

  async function submitLoan(): Promise<void> {
    formError = '';
    formToast = '';
    if (selectedIds.length === 0) {
      formError = '请先勾选要点交的印石';
      return;
    }
    if (!borrower.trim()) {
      formError = '请填写借展方';
      return;
    }
    if (!expectedReturnDate) {
      formError = '请填写归还日';
      return;
    }
    submitting = true;
    try {
      const batch = await createLoanBatch({
        borrower,
        eventName,
        expectedReturnDate,
        note,
        stoneIds: selectedIds,
      });
      formToast = `点交成功：${batch.batchNo}，${batch.itemCount} 方已借出`;
      // 点交成功后清空选择（原清单仍在下方「借出中」可查）
      selectedIds = [];
      note = '';
    } catch (err) {
      if (err instanceof LoanConflictError) {
        // 并发冲突：保留原清单，提示后可从原清单重试
        formError = err.message;
      } else {
        formError = err instanceof Error ? err.message : '点交失败，请从原清单重试';
      }
    } finally {
      submitting = false;
    }
  }

  /* ------------------------------ 归还（逐方核对） ------------------------------ */

  interface ReturnInput {
    hasDamage: boolean;
    damage: string;
    maintenance: string;
  }

  let returnBatch = $state<LoanBatch | null>(null);
  let returnInputs = $state<Record<string, ReturnInput>>({});
  let returning = $state(false);
  let returnError = $state('');

  function openReturn(batch: LoanBatch): void {
    returnBatch = batch;
    returnError = '';
    const inputs: Record<string, ReturnInput> = {};
    loanItemsOfBatch(batch.id)
      .filter((item) => item.status === 'lent')
      .forEach((item) => {
        inputs[item.id] = { hasDamage: false, damage: '', maintenance: '' };
      });
    returnInputs = inputs;
  }

  function setReturnHasDamage(itemId: string, hasDamage: boolean): void {
    returnInputs = {
      ...returnInputs,
      [itemId]: { ...returnInputs[itemId], hasDamage },
    };
  }

  async function confirmReturn(): Promise<void> {
    if (!returnBatch) return;
    returnError = '';
    const entries = Object.entries(returnInputs);
    if (entries.length === 0) {
      returnError = '没有可归还的条目';
      return;
    }
    returning = true;
    try {
      await returnLoanItems(
        returnBatch.id,
        entries.map(([itemId, input]) => ({
          itemId,
          hasDamage: input.hasDamage,
          damage: input.damage,
          maintenance: input.maintenance,
        })),
      );
      returnBatch = null;
    } catch (err) {
      // 任一写入失败整批回滚，保留对话框与原填写内容以便重试
      returnError = err instanceof Error ? err.message : '归还失败，整批已恢复，请重试';
    } finally {
      returning = false;
    }
  }

  /* ------------------------------ 待处理结清 ------------------------------ */

  let resolveItem = $state<LoanItem | null>(null);
  let resolveMaintenance = $state('');
  let resolving = $state(false);
  let resolveError = $state('');

  function openResolve(item: LoanItem): void {
    resolveItem = item;
    resolveMaintenance = item.maintenance;
    resolveError = '';
  }

  async function confirmResolve(): Promise<void> {
    if (!resolveItem) return;
    if (!resolveMaintenance.trim()) {
      resolveError = '请填写养护结论';
      return;
    }
    resolving = true;
    try {
      await resolveLoanItem(resolveItem.id, resolveMaintenance);
      resolveItem = null;
    } catch (err) {
      resolveError = err instanceof Error ? err.message : '处理失败，请重试';
    } finally {
      resolving = false;
    }
  }

  /* ------------------------------ 展示辅助 ------------------------------ */

  function stoneNameOf(stoneId: string): string {
    return $stones.find((stone) => stone.id === stoneId)?.name ?? '（印石已删除）';
  }

  function snapshotOf(batch: LoanBatch): ReturnType<typeof parseSnapshot> {
    return parseSnapshot(batch.sealSnapshot);
  }

  function itemStatusBadge(item: LoanItem): string {
    const color = LOAN_ITEM_STATUS_COLOR[item.status];
    return `color:${color};border-color:${color}66;background:${color}1a`;
  }
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h2 class="text-xl tracking-wide text-ink">借展点交</h2>
      <p class="mt-1 text-sm text-ink-soft">
        从已收录未借出的印石选一批出库，登记借展方与归还日；借出期间印稿、工序与钤印记录自动锁定。
      </p>
    </div>
    <button class="gb-btn" onclick={() => void loadLoans()}>刷新</button>
  </div>

  <div class="flex flex-wrap gap-3">
    <StatBadge label="可借印石" value={stat.eligible} suffix="方" tone="jade" />
    <StatBadge label="借出中" value={stat.lent} suffix="方" tone="seal" />
    <StatBadge label="在借批次" value={stat.active} suffix="批" tone="amber" />
    <StatBadge label="待处理" value={stat.pending} suffix="项" tone="amber" />
    <StatBadge label="已归还批次" value={stat.returned} suffix="批" tone="ink" />
  </div>

  <!-- 点交出库 -->
  <section class="gb-panel space-y-3">
    <header class="flex flex-wrap items-center justify-between gap-2">
      <h3 class="text-base text-ink">点交出库</h3>
      <button class="gb-btn px-2 py-1 text-xs" onclick={selectAll}>
        {selectedIds.length === eligibleStones.length && eligibleStones.length > 0 ? '清空选择' : '全选可借'}
      </button>
    </header>

    {#if eligibleStones.length === 0}
      <EmptyPanel
        title="没有可借的印石"
        description="需先在「印谱汇总」把印石收录进印谱；已借出的印石归还后会回到这里。"
        size="small"
      />
    {:else}
      <div class="overflow-x-auto">
        <table class="gb-table">
          <thead>
            <tr>
              <th class="w-12">选</th>
              <th>印石 / 印文</th>
              <th class="w-28">石种</th>
              <th class="w-24">谱录序</th>
              <th class="w-24">最佳评级</th>
            </tr>
          </thead>
          <tbody>
            {#each eligibleStones as item (item.stone.id)}
              <tr>
                <td>
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(item.stone.id)}
                    onchange={() => toggleSelect(item.stone.id)}
                  />
                </td>
                <td>
                  <div class="font-medium text-ink">{item.stone.name}</div>
                  <div class="text-xs text-ink-soft">
                    {item.design?.sealText || '未设印文'} · {item.design?.annotation || '无释文'}
                  </div>
                </td>
                <td>{STONE_TYPE_LABEL[item.stone.stoneType]}</td>
                <td class="tabular-nums">第 {item.catalog.orderNo} 方</td>
                <td>
                  {#if item.best}
                    <span class="gb-tag" style="color:#9c2b1f;border-color:#9c2b1f66">{item.best.grade === 'excellent' ? '优' : item.best.grade === 'good' ? '良' : item.best.grade === 'fair' ? '一般' : '废'}</span>
                  {:else}
                    <span class="text-xs text-ink-soft">未钤印</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <label class="block">
          <span class="gb-label">借展方 *</span>
          <input class="gb-input" bind:value={borrower} placeholder="如：西泠印社" />
        </label>
        <label class="block">
          <span class="gb-label">展览名称</span>
          <input class="gb-input" bind:value={eventName} placeholder="如：金石篆刻艺术展" />
        </label>
        <label class="block">
          <span class="gb-label">归还日 *</span>
          <input class="gb-input" type="date" bind:value={expectedReturnDate} />
        </label>
        <label class="block">
          <span class="gb-label">备注</span>
          <input class="gb-input" bind:value={note} placeholder="点交说明" />
        </label>
      </div>

      {#if formError}
        <div class="rounded-xl border border-seal/40 bg-seal/10 px-4 py-2 text-sm text-seal">{formError}</div>
      {/if}
      {#if formToast}
        <div class="rounded-xl border border-jade/40 bg-jade/10 px-4 py-2 text-sm text-jade">{formToast}</div>
      {/if}

      <div class="flex justify-end">
        <button class="gb-btn-primary" disabled={submitting} onclick={() => void submitLoan()}>
          {submitting ? '点交中…' : `点交出库（${selectedIds.length} 方）`}
        </button>
      </div>
      <p class="text-xs text-ink-soft">
        点交时冻结印谱快照并整批进入借出；若多个标签同时点交同一批印石，后提交的批次会被拒绝，不会覆盖先完成的借出。
      </p>
    {/if}
  </section>

  <!-- 待处理（归还时有缺损） -->
  {#if pendingWithRefs.length > 0}
    <section class="gb-panel space-y-3 border-amber/40">
      <header class="flex items-center justify-between">
        <h3 class="text-base text-ink">待处理（{pendingWithRefs.length} 项）</h3>
        <span class="text-xs text-amber">归还时登记了缺损，请补录养护结论</span>
      </header>
      <div class="overflow-x-auto">
        <table class="gb-table">
          <thead>
            <tr>
              <th>印石 / 印文</th>
              <th class="w-40">借展批次</th>
              <th>缺损情况</th>
              <th class="w-40">养护结论</th>
              <th class="w-24">操作</th>
            </tr>
          </thead>
          <tbody>
            {#each pendingWithRefs as { item, batch, stone } (item.id)}
              <tr>
                <td>
                  <div class="font-medium text-ink">{stone?.name ?? '（印石已删除）'}</div>
                  <div class="text-xs text-ink-soft">{item.sealText}</div>
                </td>
                <td class="text-xs">{batch?.batchNo ?? '—'}</td>
                <td class="text-sm text-seal">{item.damage || '—'}</td>
                <td class="text-xs text-ink-soft">{item.maintenance || '待补录'}</td>
                <td>
                  <button class="gb-btn-primary px-2 py-1 text-xs" onclick={() => openResolve(item)}>处理</button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  {/if}

  <!-- 借出中 -->
  <section class="space-y-3">
    <h3 class="text-base text-ink">借出中批次（{activeWithItems.length} 批）</h3>
    {#if activeWithItems.length === 0}
      <EmptyPanel title="当前没有借出中的批次" description="在上方勾选已收录未借出的印石即可点交出库。" size="small" />
    {:else}
      {#each activeWithItems as { batch, items } (batch.id)}
        <article class="gb-panel space-y-3">
          <header class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-semibold text-ink">{batch.batchNo}</span>
              <span class="gb-tag" style="color:{LOAN_BATCH_STATUS_COLOR[batch.status]};border-color:{LOAN_BATCH_STATUS_COLOR[batch.status]}66">
                {LOAN_BATCH_STATUS_LABEL[batch.status]}
              </span>
              <span class="text-sm text-ink-soft">{batch.borrower}{batch.eventName ? ` · ${batch.eventName}` : ''}</span>
            </div>
            <div class="text-xs text-ink-soft">
              借出 {batch.loanDate} · 应还 {batch.expectedReturnDate} · {batch.itemCount} 方
            </div>
          </header>

          <div class="flex flex-wrap gap-2">
            {#each snapshotOf(batch) as snap (snap.stoneId)}
              <span class="gb-tag" style="color:#23282a;border-color:#23282a33;background:#23282a0d">
                {snap.stoneName} · {snap.sealText || '未设印文'}
              </span>
            {/each}
          </div>

          <div class="overflow-x-auto">
            <table class="gb-table">
              <thead>
                <tr>
                  <th>印石 / 印文</th>
                  <th class="w-28">状态</th>
                  <th class="w-32">归还日</th>
                  <th>缺损 / 养护</th>
                </tr>
              </thead>
              <tbody>
                {#each items as item (item.id)}
                  <tr>
                    <td>
                      <div class="font-medium text-ink">{stoneNameOf(item.stoneId)}</div>
                      <div class="text-xs text-ink-soft">{item.sealText}</div>
                    </td>
                    <td>
                      <span class="gb-tag" style={itemStatusBadge(item)}>{LOAN_ITEM_STATUS_LABEL[item.status]}</span>
                    </td>
                    <td class="text-xs">{item.returnedAt || '—'}</td>
                    <td class="text-xs text-ink-soft">
                      {#if item.status === 'pending'}
                        <span class="text-seal">缺损：{item.damage}</span>
                      {:else if item.status === 'returned'}
                        {item.maintenance || '—'}
                      {:else}
                        借出中
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>

          <div class="flex justify-end">
            <button class="gb-btn-primary" onclick={() => openReturn(batch)}>逐方归还</button>
          </div>
        </article>
      {/each}
    {/if}
  </section>

  <!-- 已归还历史 -->
  {#if returnedWithItems.length > 0}
    <section class="space-y-3">
      <h3 class="text-base text-ink">已归还批次（{returnedWithItems.length} 批）</h3>
      {#each returnedWithItems as { batch, items } (batch.id)}
        <article class="gb-panel space-y-2 opacity-90">
          <header class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-semibold text-ink">{batch.batchNo}</span>
              <span class="gb-tag" style="color:{LOAN_BATCH_STATUS_COLOR[batch.status]};border-color:{LOAN_BATCH_STATUS_COLOR[batch.status]}66">
                {LOAN_BATCH_STATUS_LABEL[batch.status]}
              </span>
              <span class="text-sm text-ink-soft">{batch.borrower}</span>
            </div>
            <div class="text-xs text-ink-soft">
              借出 {batch.loanDate} · 应还 {batch.expectedReturnDate} · {batch.itemCount} 方
            </div>
          </header>
          <ul class="space-y-1 text-sm">
            {#each items as item (item.id)}
              <li class="flex flex-wrap gap-2">
                <span class="text-ink">{stoneNameOf(item.stoneId)}</span>
                <span class="text-ink-soft">（{item.sealText}）</span>
                {#if item.damage}<span class="text-seal">缺损：{item.damage}</span>{/if}
                <span class="text-ink-soft">养护：{item.maintenance || '—'}</span>
                <span class="text-xs text-ink-soft">· {item.returnedAt} 归还</span>
              </li>
            {/each}
          </ul>
        </article>
      {/each}
    </section>
  {/if}

  <p class="text-xs text-ink-soft">
    点交后整批进入借出，印稿、工序与钤印记录锁定只读；归还时逐方核对，有缺损先列入「待处理」，结清养护结论后整批归档。
  </p>
</div>

<!-- 逐方归还对话框 -->
{#if returnBatch}
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/40 px-4">
    <div class="w-full max-w-2xl rounded-xl border border-line bg-paper-light p-5 shadow-xl">
      <h3 class="mb-1 text-lg text-ink">逐方归还 · {returnBatch.batchNo}</h3>
      <p class="mb-3 text-xs text-ink-soft">
        {returnBatch.borrower} · 应还 {returnBatch.expectedReturnDate} · 逐方核对印面与缺损后登记
      </p>
      <div class="max-h-[50vh] space-y-3 overflow-y-auto">
        {#each loanItemsOfBatch(returnBatch.id).filter((item) => item.status === 'lent') as item (item.id)}
          <div class="rounded-xl border border-line bg-white/60 p-3">
            <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div>
                <span class="font-medium text-ink">{stoneNameOf(item.stoneId)}</span>
                <span class="ml-2 text-xs text-ink-soft">{item.sealText}</span>
              </div>
              <label class="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={returnInputs[item.id]?.hasDamage ?? false}
                  onchange={(event) => setReturnHasDamage(item.id, (event.currentTarget as HTMLInputElement).checked)}
                />
                <span class="text-seal">有缺损（列入待处理）</span>
              </label>
            </div>
            {#if returnInputs[item.id]?.hasDamage}
              <textarea
                class="gb-input mb-2"
                rows="2"
                placeholder="缺损情况，如：印面边角磕碰、锦盒压痕"
                bind:value={returnInputs[item.id].damage}
              ></textarea>
            {/if}
            <input
              class="gb-input"
              placeholder="养护结论，如：核对印面无损，清洁后薄涂保养油入锦盒"
              bind:value={returnInputs[item.id].maintenance}
            />
          </div>
        {/each}
      </div>

      {#if returnError}
        <div class="mt-3 rounded-xl border border-seal/40 bg-seal/10 px-4 py-2 text-sm text-seal">{returnError}</div>
      {/if}

      <div class="mt-4 flex justify-end gap-2">
        <button class="gb-btn" onclick={() => (returnBatch = null)} disabled={returning}>取消</button>
        <button class="gb-btn-primary" disabled={returning} onclick={() => void confirmReturn()}>
          {returning ? '归还中…' : '确认归还（整批）'}
        </button>
      </div>
      <p class="mt-2 text-xs text-ink-soft">任一写入失败整批恢复，可在此对话框直接重试。</p>
    </div>
  </div>
{/if}

<!-- 待处理结清对话框 -->
{#if resolveItem}
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/40 px-4">
    <div class="w-full max-w-md rounded-xl border border-line bg-paper-light p-5 shadow-xl">
      <h3 class="mb-1 text-lg text-ink">处理待处理</h3>
      <p class="mb-3 text-sm text-ink-soft">
        {stoneNameOf(resolveItem.stoneId)} · {resolveItem.sealText}
        {#if resolveItem.damage}
          · 缺损：<span class="text-seal">{resolveItem.damage}</span>
        {/if}
      </p>
      <label class="block">
        <span class="gb-label">养护结论 *</span>
        <textarea class="gb-input" rows="3" bind:value={resolveMaintenance} placeholder="记录核对与养护处理结论"
        ></textarea>
      </label>
      <div class="mt-2 flex flex-wrap gap-1">
        {#each MAINTENANCE_TEMPLATE_OPTIONS as option (option)}
          <button
            class="rounded-full border border-line px-2 py-0.5 text-xs text-ink-soft hover:bg-black/5"
            onclick={() => (resolveMaintenance = option)}
          >
            {option}
          </button>
        {/each}
      </div>
      {#if resolveError}
        <div class="mt-3 rounded-xl border border-seal/40 bg-seal/10 px-4 py-2 text-sm text-seal">{resolveError}</div>
      {/if}
      <div class="mt-4 flex justify-end gap-2">
        <button class="gb-btn" onclick={() => (resolveItem = null)} disabled={resolving}>取消</button>
        <button class="gb-btn-primary" disabled={resolving} onclick={() => void confirmResolve()}>
          {resolving ? '提交中…' : '确认结清'}
        </button>
      </div>
    </div>
  </div>
{/if}
