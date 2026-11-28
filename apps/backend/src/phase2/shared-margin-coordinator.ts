import { Decimal } from 'decimal.js';
import type { GateCrossExAccount, GateCrossExMarginPosition, GateCrossExPosition } from '../crossex-client.js';

export interface AccountRiskSnapshot {
  fetchedAt: string;
  accountMode: string;
  positionMode: string;
  marginBalanceUsd: string;
  availableMarginUsd: string;
  initialMarginUsd: string;
  maintenanceMarginUsd: string;
  maintenanceMarginRate: string;
  assetLiabilities: Array<{
    venue: string;
    coin: string;
    available: string;
    liability: string;
    futuresInitialMargin: string;
    borrowingInitialMargin: string;
  }>;
  marginPositionInterestUsd: string;
}

export interface Phase2RiskLimitsConfig {
  /** Must stay '0' in shadow/simulation until business authorizes real open-position budget. */
  liveOpenNotionalCapUsd: string;
  shadowAccountBudgetUsd: string;
  maxPairNotionalUsd: string;
  maxOrderNotionalUsd: string;
  maxLeverage: string;
  minAvailableMarginBufferRatio: string;
  maxNakedNotionalUsd: string;
  maxNakedDurationMs: number;
  maxTrialLossUsd: string;
}

export const DEFAULT_SHADOW_RISK_LIMITS: Phase2RiskLimitsConfig = {
  liveOpenNotionalCapUsd: '0',
  shadowAccountBudgetUsd: '2000',
  maxPairNotionalUsd: '2000',
  maxOrderNotionalUsd: '1000',
  maxLeverage: '5',
  minAvailableMarginBufferRatio: '0.15',
  maxNakedNotionalUsd: '1000',
  maxNakedDurationMs: 5_000,
  maxTrialLossUsd: '25',
};

export interface MarginReservation {
  reservationId: string;
  strategyId: string;
  reservedMarginUsd: string;
  plannedNotionalUsd: string;
  mode: 'SHADOW' | 'LIVE';
  createdAtMs: number;
}

export interface GuardrailBreach {
  code:
    | 'NAKED_NOTIONAL_EXCEEDED'
    | 'NAKED_DURATION_EXCEEDED'
    | 'TRIAL_LOSS_EXCEEDED'
    | 'MAINTENANCE_MARGIN_BUFFER_BREACH';
  action: 'CANCEL_OPEN_ORDERS_AND_REDUCE_ONLY_FLATTEN';
  detail: string;
}

export function summarizeAccountSnapshot(
  account: GateCrossExAccount,
  marginPositions: readonly GateCrossExMarginPosition[] = [],
  fetchedAt = new Date().toISOString(),
): AccountRiskSnapshot {
  const interest = marginPositions.reduce(
    (sum, p) => sum.plus(p.interest || '0'),
    new Decimal(0),
  );
  return {
    fetchedAt,
    accountMode: account.account_mode,
    positionMode: account.position_mode,
    marginBalanceUsd: account.margin_balance,
    availableMarginUsd: account.available_margin,
    initialMarginUsd: account.initial_margin,
    maintenanceMarginUsd: account.maintenance_margin,
    maintenanceMarginRate: account.maintenance_margin_rate,
    assetLiabilities: account.assets.map((a) => ({
      venue: a.exchange_type,
      coin: a.coin,
      available: a.available_balance,
      liability: a.liability,
      futuresInitialMargin: a.futures_initial_margin,
      borrowingInitialMargin: a.borrowing_initial_margin,
    })),
    marginPositionInterestUsd: interest.toDecimalPlaces(8).toString(),
  };
}

/**
 * Account-level shared margin coordinator enforcing single-writer concurrency across multiple
 * strategies, live-cap zero enforcement before authorization, partial-fill release, and guardrail checks.
 */
export class SharedMarginCoordinator {
  private readonly reservations = new Map<string, MarginReservation>();
  private readonly strategyNotional = new Map<string, Decimal>();

  constructor(private readonly limits: Phase2RiskLimitsConfig = DEFAULT_SHADOW_RISK_LIMITS) {}

  getLimits(): Phase2RiskLimitsConfig {
    return { ...this.limits };
  }

  getTotalReservedMarginUsd(): string {
    let total = new Decimal(0);
    for (const r of this.reservations.values()) {
      total = total.plus(r.reservedMarginUsd);
    }
    return total.toDecimalPlaces(8).toString();
  }

  getRemainingShadowMarginUsd(accountAvailableMarginUsd?: string): string {
    const basePool = accountAvailableMarginUsd !== undefined
      ? Decimal.min(this.limits.shadowAccountBudgetUsd, accountAvailableMarginUsd)
      : new Decimal(this.limits.shadowAccountBudgetUsd);
    const usable = basePool.mul(new Decimal(1).minus(this.limits.minAvailableMarginBufferRatio));
    return Decimal.max(0, usable.minus(this.getTotalReservedMarginUsd())).toDecimalPlaces(8).toString();
  }

  /**
   * Synchronously reserve margin across competing strategies so total simultaneous reservations
   * can never exceed the shared account margin after buffer. Enforces liveOpenNotionalCapUsd === '0'
   * when mode === 'LIVE' unless business authorization explicitly raised it.
   */
  tryReserve(params: {
    reservationId: string;
    strategyId: string;
    mode: 'SHADOW' | 'LIVE';
    leverage: string;
    perLegNotionalUsd: string;
    atMs: number;
    accountAvailableMarginUsd?: string;
    reduceOnly?: boolean;
  }): { ok: true; reservation: MarginReservation } | { ok: false; reason: string } {
    if (this.reservations.has(params.reservationId)) {
      return { ok: false, reason: 'DUPLICATE_RESERVATION_ID' };
    }
    if (params.reduceOnly) {
      const zeroRes: MarginReservation = {
        reservationId: params.reservationId,
        strategyId: params.strategyId,
        reservedMarginUsd: '0',
        plannedNotionalUsd: '0',
        mode: params.mode,
        createdAtMs: params.atMs,
      };
      this.reservations.set(params.reservationId, zeroRes);
      return { ok: true, reservation: zeroRes };
    }

    const perLegNotional = new Decimal(params.perLegNotionalUsd);
    const totalDualNotional = perLegNotional.mul(2);
    const leverage = new Decimal(params.leverage);

    if (params.mode === 'LIVE') {
      const liveCap = new Decimal(this.limits.liveOpenNotionalCapUsd);
      if (liveCap.lte(0)) {
        return { ok: false, reason: 'LIVE_OPEN_CAP_ZERO_SHADOW_ONLY' };
      }
      if (totalDualNotional.gt(liveCap)) {
        return { ok: false, reason: 'LIVE_OPEN_NOTIONAL_CAP_EXCEEDED' };
      }
    }

    if (leverage.gt(this.limits.maxLeverage)) {
      return { ok: false, reason: 'LEVERAGE_EXCEEDS_MAX' };
    }
    if (perLegNotional.gt(this.limits.maxOrderNotionalUsd)) {
      return { ok: false, reason: 'PER_ORDER_NOTIONAL_EXCEEDED' };
    }

    const curStrategyNotional = this.strategyNotional.get(params.strategyId) ?? new Decimal(0);
    if (curStrategyNotional.plus(totalDualNotional).gt(this.limits.maxPairNotionalUsd)) {
      return { ok: false, reason: 'PAIR_NOTIONAL_CAP_EXCEEDED' };
    }

    // 10% preflight buffer + leverage margin requirement across both legs.
    const requiredMargin = totalDualNotional.div(leverage).mul('1.10').toDecimalPlaces(8);
    const remainingMargin = new Decimal(this.getRemainingShadowMarginUsd(params.accountAvailableMarginUsd));
    if (requiredMargin.gt(remainingMargin)) {
      return { ok: false, reason: 'INSUFFICIENT_SHARED_MARGIN' };
    }

    const reservation: MarginReservation = {
      reservationId: params.reservationId,
      strategyId: params.strategyId,
      reservedMarginUsd: requiredMargin.toString(),
      plannedNotionalUsd: totalDualNotional.toString(),
      mode: params.mode,
      createdAtMs: params.atMs,
    };
    this.reservations.set(params.reservationId, reservation);
    this.strategyNotional.set(params.strategyId, curStrategyNotional.plus(totalDualNotional));
    return { ok: true, reservation };
  }

  /**
   * Adjust reservation downward after partial fills / terminal cancellations (or release fully
   * on zero-fill / position close) so unused capacity returns cleanly to the shared pool.
   */
  settleReservation(reservationId: string, executedRatio: string): MarginReservation | null {
    const existing = this.reservations.get(reservationId);
    if (!existing) return null;
    const ratio = Decimal.max(0, Decimal.min(1, new Decimal(executedRatio)));
    if (ratio.eq(0)) {
      this.releaseReservation(reservationId);
      return null;
    }
    const prevNotional = new Decimal(existing.plannedNotionalUsd);
    const newNotional = prevNotional.mul(ratio).toDecimalPlaces(8);
    const newMargin = new Decimal(existing.reservedMarginUsd).mul(ratio).toDecimalPlaces(8);
    const curStrategy = this.strategyNotional.get(existing.strategyId) ?? new Decimal(0);
    this.strategyNotional.set(
      existing.strategyId,
      Decimal.max(0, curStrategy.minus(prevNotional).plus(newNotional)),
    );
    const updated: MarginReservation = {
      ...existing,
      reservedMarginUsd: newMargin.toString(),
      plannedNotionalUsd: newNotional.toString(),
    };
    this.reservations.set(reservationId, updated);
    return updated;
  }

  releaseReservation(reservationId: string): boolean {
    const existing = this.reservations.get(reservationId);
    if (!existing) return false;
    this.reservations.delete(reservationId);
    const curStrategy = this.strategyNotional.get(existing.strategyId) ?? new Decimal(0);
    this.strategyNotional.set(
      existing.strategyId,
      Decimal.max(0, curStrategy.minus(existing.plannedNotionalUsd)),
    );
    return true;
  }

  /**
   * Evaluate live/shadow naked-leg, drawdown, and maintenance margin breach guardrails.
   */
  evaluateGuardrails(params: {
    nakedNotionalUsd: string;
    nakedDurationMs: number;
    realizedPlusUnrealizedPnlUsd: string;
    account?: GateCrossExAccount;
  }): GuardrailBreach[] {
    const breaches: GuardrailBreach[] = [];
    if (new Decimal(params.nakedNotionalUsd).gt(this.limits.maxNakedNotionalUsd)) {
      breaches.push({
        code: 'NAKED_NOTIONAL_EXCEEDED',
        action: 'CANCEL_OPEN_ORDERS_AND_REDUCE_ONLY_FLATTEN',
        detail: `Naked notional ${params.nakedNotionalUsd} > cap ${this.limits.maxNakedNotionalUsd}`,
      });
    }
    if (params.nakedDurationMs > this.limits.maxNakedDurationMs && new Decimal(params.nakedNotionalUsd).gt(0)) {
      breaches.push({
        code: 'NAKED_DURATION_EXCEEDED',
        action: 'CANCEL_OPEN_ORDERS_AND_REDUCE_ONLY_FLATTEN',
        detail: `Naked duration ${params.nakedDurationMs}ms > cap ${this.limits.maxNakedDurationMs}ms`,
      });
    }
    if (new Decimal(params.realizedPlusUnrealizedPnlUsd).lte(new Decimal(this.limits.maxTrialLossUsd).negated())) {
      breaches.push({
        code: 'TRIAL_LOSS_EXCEEDED',
        action: 'CANCEL_OPEN_ORDERS_AND_REDUCE_ONLY_FLATTEN',
        detail: `Cumulative PnL ${params.realizedPlusUnrealizedPnlUsd} breached -${this.limits.maxTrialLossUsd}`,
      });
    }
    if (params.account) {
      const bal = new Decimal(params.account.margin_balance);
      const maint = new Decimal(params.account.maintenance_margin);
      if (bal.gt(0) && maint.gt(0)) {
        const bufferRatio = bal.minus(maint).div(bal);
        if (bufferRatio.lt(this.limits.minAvailableMarginBufferRatio)) {
          breaches.push({
            code: 'MAINTENANCE_MARGIN_BUFFER_BREACH',
            action: 'CANCEL_OPEN_ORDERS_AND_REDUCE_ONLY_FLATTEN',
            detail: `Margin buffer ${bufferRatio.toFixed(4)} < min ${this.limits.minAvailableMarginBufferRatio}`,
          });
        }
      }
    }
    return breaches;
  }

  /**
   * Reconcile exchange open orders & positions against local expectations after restart before
   * permitting any new opening submissions.
   */
  reconcileAfterRestart(params: {
    openRemoteOrderIds: readonly string[];
    exchangePositions: readonly GateCrossExPosition[];
    expectedPositionsBySymbol: Readonly<Record<string, string>>;
  }): { safeToResumeOpening: boolean; blockingReasons: string[]; netResidualBySymbol: Record<string, string> } {
    const reasons: string[] = [];
    if (params.openRemoteOrderIds.length > 0) {
      reasons.push(`OPEN_ORDERS_PENDING_QUIESCE:${params.openRemoteOrderIds.length}`);
    }
    const netResidualBySymbol: Record<string, string> = {};
    const remoteQtyBySymbol = new Map<string, Decimal>();
    for (const p of params.exchangePositions) {
      const qty = new Decimal(p.position_qty || '0').abs();
      const signed = p.position_side.toUpperCase() === 'SHORT' ? qty.negated() : qty;
      remoteQtyBySymbol.set(p.symbol, signed);
    }
    const allSymbols = new Set([...remoteQtyBySymbol.keys(), ...Object.keys(params.expectedPositionsBySymbol)]);
    for (const sym of allSymbols) {
      const remote = remoteQtyBySymbol.get(sym) ?? new Decimal(0);
      const expected = new Decimal(params.expectedPositionsBySymbol[sym] ?? '0');
      const diff = remote.minus(expected);
      netResidualBySymbol[sym] = remote.toString();
      if (diff.abs().gt('1e-6')) {
        reasons.push(`POSITION_MISMATCH_${sym}:remote=${remote.toString()},expected=${expected.toString()}`);
      }
    }
    return {
      safeToResumeOpening: reasons.length === 0,
      blockingReasons: reasons,
      netResidualBySymbol,
    };
  }
}
