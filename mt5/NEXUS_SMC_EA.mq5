//+------------------------------------------------------------------+
//|                                              NEXUS_SMC_EA.mq5    |
//|                        NEXUS·SMC Signal Auto-Trader v5.0         |
//|             Full SMC: OB · FVG · BOS/CHoCH · Liquidity          |
//|                                                                  |
//|  v5.0 SAFETY HARDENING (see audit):                              |
//|   • Duplicate-trade defense in depth: server claim/lease,        |
//|     persisted executed-id file, open-position comment scan,      |
//|     optimistic marking BEFORE OrderSend (MT5-01/XSYS-01/02/03)   |
//|   • Real position-id tracking via DEAL_POSITION_ID (MT5-04)      |
//|   • Sticky daily-loss kill-switch + equity snapshot, persisted   |
//|     across restarts; max consecutive losses; max trades/day      |
//|   • Directional + broker stops-level + price-divergence guards   |
//|   • Broker filling-mode autodetect; robust SL modify + trailing  |
//|     debounce; correct partial-close volume snapping              |
//|   • Bounded JSON field parsing; robust trade reporting w/ retry  |
//+------------------------------------------------------------------+
#property copyright "NEXUS·SMC Trading System"
#property version   "5.00"
#property description "Auto-executes SMC signals with hardened risk management"
#property strict

//+------------------------------------------------------------------+
//| INPUT GROUPS                                                       |
//+------------------------------------------------------------------+

//--- API Connection
input group "═══ API CONNECTION ═══"
input string   API_URL          = "http://127.0.0.1:3001";  // API Server URL
input int      PollSeconds      = 3;                         // Poll interval (seconds)
input string   ApiKey           = "";                        // Shared secret (X-API-Key) if server NEXUS_API_TOKEN set
input bool     UseServerClaim   = true;                      // Lease each signal from server before trading (anti-duplicate)

//--- Risk Management  ← MOST CRITICAL SECTION
input group "═══ RISK MANAGEMENT ═══"
input double   RiskPercent      = 1.0;    // Risk % per trade (RECOMMENDED: 0.5–2.0%)
input double   MaxRiskPercentHard = 5.0;  // Hard ceiling: refuse to start if RiskPercent above this
input double   MaxDailyLossPercent = 5.0; // Max daily loss % (vs day-start EQUITY) before halt
input double   MaxLotSize       = 0.05;   // Hard max lot size cap (keep low for small accounts)
input double   MinLotSize       = 0.01;   // Minimum lot size
input double   MaxRiskDollars   = 20.0;   // Absolute max $ risk per trade (0 = disabled)
input double   MaxPortfolioRiskPct = 3.0; // Max combined open risk across all EA trades (% of balance)
input int      MaxOpenTrades    = 3;      // Max simultaneous trades
input int      MaxTradesPerSymbol = 1;    // Max simultaneous trades per symbol
input int      MaxTradesPerDay   = 10;    // Max NEW trades per day (0 = unlimited)
input int      MaxConsecutiveLosses = 4;  // Halt after this many losing closes in a row (0 = off)
input double   EquityGuardPct   = 0.85;   // No new trades if equity < this fraction of balance
input double   MinFreeMarginPct = 0.15;   // No new trades if free margin < this fraction of balance

//--- Entry Filters
input group "═══ ENTRY FILTERS ═══"
input int      MinConfidence    = 80;     // Minimum signal confidence %
input double   MaxSpreadPoints  = 0.0;    // Max spread (points); 0 = use spread/SL ratio gate only
input double   MaxSpreadToSLRatio = 0.20; // Reject if spread > this fraction of SL distance
input double   MaxEntryDeviation = 15.0;  // Max % of SL distance the price may stray from signal entry
input double   MaxPriceDivergencePct = 1.0; // Reject if broker price differs from signal price by > this %
input bool     SessionFilterEnabled = true; // Only trade London/NY sessions
input int      LondonOpenHour   = 7;      // London session open (server time hour)
input int      LondonCloseHour  = 16;     // London session close
input int      NewYorkOpenHour  = 13;     // New York session open (server time hour)
input int      NewYorkCloseHour = 21;     // New York session close

//--- SMC Confluence Filters
input group "═══ SMC CONFLUENCE ═══"
input bool     RequireOBProximity = true;   // Only trade if price near the signal entry (POI)
input double   OBProximityPct    = 0.3;     // How close to entry (fraction of SL distance)
input bool     RequireFVGFill    = false;   // Require signal to have FVG confirmation
input bool     RequireLiquiditySweep = false; // Require liquidity sweep before entry

//--- Trade Management
input group "═══ TRADE MANAGEMENT ═══"
input bool     UseBreakEven     = true;    // Move SL to break-even when in profit
input double   BreakEvenTriggerR = 1.0;   // Move BE when trade reaches this R-multiple
input double   BreakEvenOffsetPts = 5.0;  // BE SL offset from entry (points)
input bool     UseTrailingStop  = true;    // Enable trailing stop
input double   TrailStartR      = 1.5;    // Start trailing after this R-multiple
input double   TrailStepPoints  = 15.0;   // Trailing step in points
input bool     UsePartialClose  = true;   // Partial close at TP1
input double   PartialCloseR    = 1.0;    // Partial close at this R-multiple
input double   PartialClosePct  = 50.0;   // % of position to close at TP1
input bool     PartialRequiresBE = true;  // Only take partial once BE is locked (protect runner)

//--- EA Identity
input group "═══ EA IDENTITY ═══"
input int      MagicNumber      = 20260515;
input bool     TradeEnabled     = true;
input bool     AllowConfidenceOverride = false; // conf>=OverrideConf raises per-symbol cap by 1 (off by default)
input int      OverrideConf      = 90;
// ★ Symbols (dashboard side). SymbolMap converts to broker symbols.
input string   AllowedSymbols   = "BTCUSD,EURUSDT,Nasdaq";
input string   SymbolMap        = "BTCUSD=BTCUSD,EURUSDT=EURUSDT,Nasdaq=Nasdaq";

//+------------------------------------------------------------------+
//| INTERNAL STATE                                                     |
//+------------------------------------------------------------------+
struct TradeState {
   ulong  posId;            // POSITION_IDENTIFIER (NOT the order ticket)
   double entryPrice;
   double originalSL;
   double originalTP;
   double riskPoints;       // points from entry to original SL
   double riskMoney;        // $ at risk at original SL (for portfolio cap)
   string sigId;
   bool   breakEvenDone;
   bool   partialDone;
   bool   isActive;
};

string      executedSignals[];
int         executedCount = 0;
TradeState  openTrades[];
int         openTradeCount = 0;
string      unreported[];          // queued trade-report bodies awaiting resend
int         unreportedCount = 0;

double      dayStartEquity   = 0;
int         currentDayKey     = 0;
int         tradesToday        = 0;
int         consecLosses       = 0;
bool        halted             = false;

//+------------------------------------------------------------------+
//| GLOBAL-VARIABLE PERSISTENCE HELPERS                                |
//+------------------------------------------------------------------+
string GV(string suffix) { return "NEXUS_" + IntegerToString(MagicNumber) + "_" + suffix; }

int TodayKey()
{
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   return dt.year * 10000 + dt.mon * 100 + dt.day;
}

string ExecFileName() { return "NEXUS_executed_" + IntegerToString(MagicNumber) + ".csv"; }

//+------------------------------------------------------------------+
//| INITIALIZATION                                                     |
//+------------------------------------------------------------------+
int OnInit()
{
   // ── HARD SAFETY GATE ──
   if (RiskPercent > MaxRiskPercentHard) {
      Alert("[NEXUS] REFUSING TO START: RiskPercent ", RiskPercent,
            "% exceeds hard ceiling ", MaxRiskPercentHard, "%. Lower RiskPercent.");
      return(INIT_PARAMETERS_INCORRECT);
   }
   if (RiskPercent <= 0 || MinLotSize <= 0 || MaxLotSize < MinLotSize) {
      Alert("[NEXUS] REFUSING TO START: invalid risk/lot configuration.");
      return(INIT_PARAMETERS_INCORRECT);
   }

   SyncDay();
   LoadExecutedFromFile();
   ValidateMappedSymbols();

   Print("╔══════════════════════════════════════════════╗");
   Print("║   NEXUS·SMC EA v5.0 Initialized              ║");
   Print("║   Risk: ", DoubleToString(RiskPercent, 2), "% | Max $: ", DoubleToString(MaxRiskDollars, 2),
         " | Daily Loss: ", DoubleToString(MaxDailyLossPercent, 1), "%");
   Print("║   Dedup: claim=", (UseServerClaim ? "ON" : "OFF"),
         " | persisted ids: ", executedCount,
         " | halt: ", (halted ? "ACTIVE" : "clear"));
   Print("║   BE:", UseBreakEven, " Trail:", UseTrailingStop, " Partial:", UsePartialClose);
   Print("╚══════════════════════════════════════════════╝");

   EventSetTimer(PollSeconds);
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   Print("[NEXUS] EA Stopped. Reason: ", reason);
}

//+------------------------------------------------------------------+
//| MAIN LOOPS                                                         |
//+------------------------------------------------------------------+
void OnTimer()
{
   CheckDayRollover();
   ManageOpenTrades();      // ALWAYS protect open trades, even when halted
   FlushUnreported();

   if (!TradeEnabled)             { SendHeartbeat(); return; }
   if (halted)                    { SendHeartbeat(); return; }
   if (IsDailyLossBreached())     { TripHalt("daily loss limit reached"); FlattenIfConfigured(); SendHeartbeat(); return; }
   if (!IsEquitySafe())           { SendHeartbeat(); return; }
   if (MaxTradesPerDay > 0 && tradesToday >= MaxTradesPerDay) {
      static datetime lastTpdMsg = 0;
      if (TimeCurrent() - lastTpdMsg > 600) { Print("[NEXUS] Max trades/day reached (", tradesToday, ")."); lastTpdMsg = TimeCurrent(); }
      SendHeartbeat();
      return;
   }

   PollSignals();
   SendHeartbeat();
}

void OnTick()
{
   // Only manage open trades on tick — signal polling is timer-only.
   ManageOpenTrades();
}

//+------------------------------------------------------------------+
//| TRADE TRANSACTION — track realized losses for the kill-switch     |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction& trans,
                        const MqlTradeRequest& request,
                        const MqlTradeResult& result)
{
   if (trans.type != TRADE_TRANSACTION_DEAL_ADD) return;
   if (!HistoryDealSelect(trans.deal)) return;
   if (HistoryDealGetInteger(trans.deal, DEAL_MAGIC) != MagicNumber) return;

   long entry = HistoryDealGetInteger(trans.deal, DEAL_ENTRY);
   if (entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY) {
      // This DEAL's realized P&L (a partial close yields its own OUT deal).
      double pnl = HistoryDealGetDouble(trans.deal, DEAL_PROFIT)
                 + HistoryDealGetDouble(trans.deal, DEAL_SWAP)
                 + HistoryDealGetDouble(trans.deal, DEAL_COMMISSION);

      ulong  posId    = (ulong)HistoryDealGetInteger(trans.deal, DEAL_POSITION_ID);
      ulong  dealTick = trans.deal;                       // unique id for idempotent reporting
      string dealSym  = HistoryDealGetString(trans.deal, DEAL_SYMBOL);
      string sigId    = SigIdForPosition(posId);

      // Determine full-vs-partial from realized VOLUME in history (the live-position
      // pool may not be updated yet at deal time), and the whole-trade NET P&L.
      double netWhole = 0;
      bool   fullOut  = false;
      PositionCloseSummary(posId, netWhole, fullOut);

      // Report REALIZED per-deal P&L so dashboard analytics reflect actual outcomes
      // (not floating account profit at open). dealTick makes the report idempotent.
      ReportClosedTrade(dealSym, pnl, sigId, posId, dealTick, fullOut);

      // The consecutive-loss kill switch must be driven by WHOLE-trade outcomes, not
      // by individual partial fills — only update it once the position fully closes.
      if (fullOut) {
         MarkTradeClosedByPos(posId);
         if (netWhole < 0)      consecLosses++;
         else if (netWhole > 0) consecLosses = 0;
         GlobalVariableSet(GV("consec"), consecLosses);
         Print("[NEXUS] Position closed net P/L: $", DoubleToString(netWhole, 2),
               " | consecutive losses: ", consecLosses);
         if (MaxConsecutiveLosses > 0 && consecLosses >= MaxConsecutiveLosses)
            TripHalt("max consecutive losses (" + IntegerToString(consecLosses) + ")");
      } else {
         Print("[NEXUS] Partial close deal P/L: $", DoubleToString(pnl, 2), " (runner still open)");
      }
   }
}

//+------------------------------------------------------------------+
//| Sum a position's history: net realized P&L + full-closure test    |
//| (reliable at deal time — does NOT rely on the live-position pool) |
//+------------------------------------------------------------------+
void PositionCloseSummary(ulong posId, double &net, bool &fullyClosed)
{
   net = 0.0; fullyClosed = false;
   if (!HistorySelectByPosition(posId)) {
      fullyClosed = !PositionSelectByTicket(posId);   // best-effort fallback
      return;
   }
   double inVol = 0.0, outVol = 0.0;
   int deals = HistoryDealsTotal();
   for (int i = 0; i < deals; i++) {
      ulong dt = HistoryDealGetTicket(i);
      if (dt == 0) continue;
      long de = HistoryDealGetInteger(dt, DEAL_ENTRY);
      double vol = HistoryDealGetDouble(dt, DEAL_VOLUME);
      if (de == DEAL_ENTRY_IN) {
         inVol += vol;
      } else if (de == DEAL_ENTRY_OUT || de == DEAL_ENTRY_OUT_BY) {
         outVol += vol;
         net += HistoryDealGetDouble(dt, DEAL_PROFIT)
              + HistoryDealGetDouble(dt, DEAL_SWAP)
              + HistoryDealGetDouble(dt, DEAL_COMMISSION);
      }
   }
   fullyClosed = (inVol > 0.0 && outVol >= inVol - 1e-8);
}

//+------------------------------------------------------------------+
//| DAILY TRACKING + STICKY HALT                                       |
//+------------------------------------------------------------------+
void SyncDay()
{
   int key = TodayKey();
   if (GlobalVariableCheck(GV("dayKey")) && (int)GlobalVariableGet(GV("dayKey")) == key) {
      dayStartEquity = GlobalVariableGet(GV("dayStartEq"));
      if (dayStartEquity <= 0) dayStartEquity = AccountInfoDouble(ACCOUNT_EQUITY);
      tradesToday    = (int)GlobalVariableGet(GV("tradesToday"));
      consecLosses   = (int)GlobalVariableGet(GV("consec"));
      halted         = (GlobalVariableCheck(GV("halt")) && GlobalVariableGet(GV("halt")) > 0);
   } else {
      dayStartEquity = AccountInfoDouble(ACCOUNT_EQUITY);   // snapshot EQUITY (counts floating) — audit MT5-12
      tradesToday    = 0;
      consecLosses   = 0;
      halted         = false;
      GlobalVariableSet(GV("dayKey"), key);
      GlobalVariableSet(GV("dayStartEq"), dayStartEquity);
      GlobalVariableSet(GV("tradesToday"), 0);
      GlobalVariableSet(GV("consec"), 0);
      if (GlobalVariableCheck(GV("halt"))) GlobalVariableDel(GV("halt"));
   }
   currentDayKey = key;
}

void CheckDayRollover()
{
   if (TodayKey() != currentDayKey) {
      SyncDay();
      Print("[NEXUS] New trading day. Day-start equity: $", DoubleToString(dayStartEquity, 2),
            " | halt cleared, counters reset.");
   }
}

bool IsDailyLossBreached()
{
   double eq = AccountInfoDouble(ACCOUNT_EQUITY);
   double maxLoss = dayStartEquity * (MaxDailyLossPercent / 100.0);
   return ((dayStartEquity - eq) >= maxLoss);
}

void TripHalt(string reason)
{
   if (halted) return;
   halted = true;
   GlobalVariableSet(GV("halt"), 1);
   Print("[NEXUS] ⛔⛔ HALT: ", reason, ". No NEW trades until next day or manual reset of GlobalVariable ", GV("halt"));
}

void FlattenIfConfigured()
{
   // Daily-loss breach: leave open trades to their own SL/TP (they are already
   // protected). We intentionally do NOT market-close here to avoid crystallising
   // slippage; the halt simply stops NEW entries. Hook left for future use.
}

//+------------------------------------------------------------------+
//| EQUITY / MARGIN SAFETY GUARD                                       |
//+------------------------------------------------------------------+
bool IsEquitySafe()
{
   double balance    = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity     = AccountInfoDouble(ACCOUNT_EQUITY);
   double freeMargin = AccountInfoDouble(ACCOUNT_MARGIN_FREE);

   if (balance > 0 && equity < balance * EquityGuardPct) {
      static datetime lastEquityMsg = 0;
      if (TimeCurrent() - lastEquityMsg > 300) {
         Print("[NEXUS] ⛔ EQUITY GUARD: Equity $", DoubleToString(equity, 2),
               " < ", DoubleToString(EquityGuardPct * 100, 0), "% of balance $", DoubleToString(balance, 2));
         lastEquityMsg = TimeCurrent();
      }
      return false;
   }

   double minFree = MathMax(balance * MinFreeMarginPct, 50.0);
   if (freeMargin < minFree) {
      static datetime lastMarginMsg = 0;
      if (TimeCurrent() - lastMarginMsg > 300) {
         Print("[NEXUS] ⛔ MARGIN GUARD: Free margin $", DoubleToString(freeMargin, 2),
               " < required $", DoubleToString(minFree, 2));
         lastMarginMsg = TimeCurrent();
      }
      return false;
   }
   return true;
}

//+------------------------------------------------------------------+
//| SESSION FILTER                                                     |
//+------------------------------------------------------------------+
bool IsInTradingSession()
{
   if (!SessionFilterEnabled) return true;
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   int hour = dt.hour;
   bool inLondon  = (hour >= LondonOpenHour  && hour < LondonCloseHour);
   bool inNewYork = (hour >= NewYorkOpenHour && hour < NewYorkCloseHour);
   return (inLondon || inNewYork);
}

//+------------------------------------------------------------------+
//| SPREAD FILTER — absolute cap AND fraction-of-SL gate               |
//+------------------------------------------------------------------+
bool IsSpreadAcceptable(string symbol, double slDist)
{
   double ask = SymbolInfoDouble(symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(symbol, SYMBOL_BID);
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   if (point <= 0) return false;
   double spread = ask - bid;
   double spreadPoints = spread / point;

   if (MaxSpreadPoints > 0 && spreadPoints > MaxSpreadPoints) {
      Print("[NEXUS] ⚠ Spread ", DoubleToString(spreadPoints, 1), " pts > max ", DoubleToString(MaxSpreadPoints, 1), " on ", symbol);
      return false;
   }
   if (MaxSpreadToSLRatio > 0 && slDist > 0 && spread > slDist * MaxSpreadToSLRatio) {
      Print("[NEXUS] ⚠ Spread $", DoubleToString(spread, 5), " > ", DoubleToString(MaxSpreadToSLRatio * 100, 0),
            "% of SL distance ($", DoubleToString(slDist, 5), ") on ", symbol);
      return false;
   }
   return true;
}

//+------------------------------------------------------------------+
//| ENTRY VALIDATION — proximity, deviation, price divergence          |
//+------------------------------------------------------------------+
bool IsPriceCloseToSignal(string symbol, string type, double signalEntry, double sl)
{
   // Always enforce at least one anti-chase gate (audit MT5-08/11).
   bool proximityOn = RequireOBProximity;
   bool deviationOn = (MaxEntryDeviation > 0);
   if (!proximityOn && !deviationOn) proximityOn = true;  // fail-safe default

   double price = (type == "BUY") ? SymbolInfoDouble(symbol, SYMBOL_ASK)
                                   : SymbolInfoDouble(symbol, SYMBOL_BID);
   double slDistance = MathAbs(signalEntry - sl);
   if (slDistance <= 0) return false;
   double priceDelta = MathAbs(price - signalEntry);

   if (deviationOn) {
      double maxDev = slDistance * (MaxEntryDeviation / 100.0);
      if (priceDelta > maxDev) {
         Print("[NEXUS] ⚠ Price ", DoubleToString(price, 5), " strayed ", DoubleToString(priceDelta, 5),
               " from entry ", DoubleToString(signalEntry, 5), " (max ", DoubleToString(maxDev, 5), ")");
         return false;
      }
   }
   if (proximityOn) {
      double obWindow = slDistance * OBProximityPct;
      if (priceDelta > obWindow) {
         Print("[NEXUS] ⚠ Price not at POI. entry ", DoubleToString(signalEntry, 5),
               " cur ", DoubleToString(price, 5), " window ±", DoubleToString(obWindow, 5));
         return false;
      }
   }
   return true;
}

bool IsPriceConsistent(string symbol, double signalEntry)
{
   // Cross-instrument guard: reject if broker price diverges from the signal's
   // price by more than MaxPriceDivergencePct (audit SRV-02).
   if (MaxPriceDivergencePct <= 0 || signalEntry <= 0) return true;
   double bid = SymbolInfoDouble(symbol, SYMBOL_BID);
   if (bid <= 0) return false;
   double div = MathAbs(bid - signalEntry) / signalEntry * 100.0;
   if (div > MaxPriceDivergencePct) {
      Print("[NEXUS] ⛔ Price divergence ", DoubleToString(div, 2), "% between broker (", DoubleToString(bid, 5),
            ") and signal (", DoubleToString(signalEntry, 5), ") on ", symbol, " — wrong instrument? Skipping.");
      return false;
   }
   return true;
}

bool PassesSMCFilters(bool hasFVG, bool hasLiqSweep)
{
   if (RequireFVGFill && !hasFVG)          { Print("[NEXUS] ⚠ Rejected: no FVG confirmation"); return false; }
   if (RequireLiquiditySweep && !hasLiqSweep) { Print("[NEXUS] ⚠ Rejected: no liquidity sweep"); return false; }
   return true;
}

//+------------------------------------------------------------------+
//| POLL SIGNALS FROM API                                              |
//+------------------------------------------------------------------+
void PollSignals()
{
   if (!IsInTradingSession()) {
      static datetime lastSessionMsg = 0;
      if (TimeCurrent() - lastSessionMsg > 3600) { Print("[NEXUS] Outside trading session."); lastSessionMsg = TimeCurrent(); }
      return;
   }

   string url = API_URL + "/api/signals?min_confidence=" + IntegerToString(MinConfidence) + "&status=ACTIVE";
   string cookie = NULL, resultHeaders;
   char   post[], result[];

   ResetLastError();
   int httpCode = WebRequest("GET", url, cookie, NULL, 5000, post, 0, result, resultHeaders);
   if (httpCode != 200) {
      int err = GetLastError();
      if (err == 4014)
         Print("[NEXUS] ⛔ Add '", API_URL, "' to Tools > Options > Expert Advisors > Allow WebRequest");
      else
         Print("[NEXUS] API Error: HTTP ", httpCode, " | Error: ", err);
      return;
   }
   ProcessSignals(CharArrayToString(result));
}

//+------------------------------------------------------------------+
//| PROCESS SIGNALS JSON                                               |
//+------------------------------------------------------------------+
void ProcessSignals(string json)
{
   int currentOpen = CountOpenTrades();
   if (currentOpen >= MaxOpenTrades) return;

   int pos = 0;
   int jsonLen = StringLen(json);
   while (pos < jsonLen)
   {
      if (currentOpen >= MaxOpenTrades) break;
      if (MaxTradesPerDay > 0 && tradesToday >= MaxTradesPerDay) break;

      int sigStart = StringFind(json, "\"id\":", pos);
      if (sigStart < 0) break;

      // Bound this signal's fields to [sigStart, nextSig) so a missing field is
      // NEVER read from the next object (audit XSYS-04).
      int nextSig = StringFind(json, "\"id\":", sigStart + 5);
      int upTo = (nextSig > 0) ? nextSig : jsonLen;
      pos = (nextSig > 0) ? nextSig : jsonLen;

      string sigId     = ExtractString(json, "\"id\":",         sigStart, upTo);
      string sigType   = ExtractString(json, "\"type\":",       sigStart, upTo);
      string sigSymbol = ExtractString(json, "\"symbol\":",     sigStart, upTo);
      double sigConf   = ExtractDouble(json, "\"confidence\":", sigStart, upTo);
      double sigEntry  = ExtractDouble(json, "\"entry\":",      sigStart, upTo);
      double sigSL     = ExtractDouble(json, "\"sl\":",         sigStart, upTo);
      double sigTP     = ExtractDouble(json, "\"tp\":",         sigStart, upTo);
      string sigStatus = ExtractString(json, "\"status\":",     sigStart, upTo);
      bool   hasFVG      = ExtractBool(json, "\"hasFVG\":",            sigStart, upTo);
      bool   hasLiqSweep = ExtractBool(json, "\"hasLiquiditySweep\":", sigStart, upTo);
      bool   hasBOS      = ExtractBool(json, "\"hasBOS\":",            sigStart, upTo);
      bool   hasCHoCH    = ExtractBool(json, "\"hasCHoCH\":",          sigStart, upTo);

      if (StringLen(sigId) == 0 || StringLen(sigSymbol) == 0) continue;
      if (sigType != "BUY" && sigType != "SELL")              continue;
      if (sigConf < MinConfidence)                            continue;
      if (sigStatus != "ACTIVE")                              continue;
      if (sigSL <= 0 || sigTP <= 0 || sigEntry <= 0)          continue;
      if (IsSignalExecuted(sigId))                            continue;
      if (!IsSymbolAllowed(sigSymbol))                        continue;

      string brokerSym = MapSymbol(sigSymbol);
      if (!SymbolSelect(brokerSym, true)) { Print("[NEXUS] Symbol unavailable: ", brokerSym); continue; }

      // Open-position scan: skip if a position already carries this signal id
      // (robust to restart and to a prior false-but-filled OrderSend) — audit MT5-01.
      if (PositionExistsForSignal(sigId)) { MarkSignalExecuted(sigId); continue; }

      int symbolTrades  = CountOpenTradesBySymbol(brokerSym);
      int allowedTrades = MaxTradesPerSymbol;
      if (AllowConfidenceOverride && sigConf >= OverrideConf) allowedTrades += 1;
      if (symbolTrades >= allowedTrades) continue;

      Print("[NEXUS] Signal ", sigId, " | ", sigType, " ", brokerSym, " | Conf ", DoubleToString(sigConf, 0),
            "% | BOS:", hasBOS, " CHoCH:", hasCHoCH, " FVG:", hasFVG, " Sweep:", hasLiqSweep);

      // ── Filters (cheap → expensive) ──
      if (!IsPriceConsistent(brokerSym, sigEntry))                     continue;
      double slDistGuess = MathAbs(sigEntry - sigSL);
      if (!IsSpreadAcceptable(brokerSym, slDistGuess))                continue;
      if (!IsPriceCloseToSignal(brokerSym, sigType, sigEntry, sigSL)) continue;
      if (!PassesSMCFilters(hasFVG, hasLiqSweep))                     continue;

      // ── Atomic claim immediately before sending (anti-duplicate gate) ──
      if (!ClaimSignal(sigId)) continue;

      // ── Optimistic mark BEFORE OrderSend so a slow report / re-poll cannot re-fire ──
      MarkSignalExecuted(sigId);

      bool ok = ExecuteTrade(brokerSym, sigType, sigEntry, sigSL, sigTP, sigConf, sigId);
      if (ok) {
         currentOpen++;
         tradesToday++;
         GlobalVariableSet(GV("tradesToday"), tradesToday);
      } else {
         Print("[NEXUS] Execution failed for ", sigId, " (left marked to avoid duplicate retries).");
      }
   }
}

//+------------------------------------------------------------------+
//| EXECUTE TRADE                                                      |
//+------------------------------------------------------------------+
bool ExecuteTrade(string symbol, string type, double entry, double sl, double tp, double conf, string sigId)
{
   ENUM_ORDER_TYPE orderType = (type == "BUY") ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;

   double ask = SymbolInfoDouble(symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(symbol, SYMBOL_BID);
   double price = (type == "BUY") ? ask : bid;
   if (price <= 0) { Print("[NEXUS] ✗ Invalid price for ", symbol); return false; }

   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   sl = NormalizeDouble(sl, digits);
   tp = NormalizeDouble(tp, digits);

   // ── Directional sanity vs the ACTUAL fill price (audit MT5-03) ──
   if (type == "BUY"  && !(sl < price && tp > price)) {
      Print("[NEXUS] ✗ BUY rejected: SL/TP not bracketing price. price=", DoubleToString(price, digits),
            " sl=", DoubleToString(sl, digits), " tp=", DoubleToString(tp, digits)); return false;
   }
   if (type == "SELL" && !(sl > price && tp < price)) {
      Print("[NEXUS] ✗ SELL rejected: SL/TP not bracketing price. price=", DoubleToString(price, digits),
            " sl=", DoubleToString(sl, digits), " tp=", DoubleToString(tp, digits)); return false;
   }

   // ── Broker minimum stop distance (audit MT5-03) ──
   long stopsLevel = SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL);
   double minDist = (double)stopsLevel * point;
   if (minDist > 0) {
      if (MathAbs(price - sl) < minDist || MathAbs(tp - price) < minDist) {
         Print("[NEXUS] ✗ Rejected: SL/TP inside broker stops level (", stopsLevel, " pts) on ", symbol);
         return false;
      }
   }

   double lotSize = CalculateLotSize(symbol, price, sl, type);
   if (lotSize <= 0) { Print("[NEXUS] ✗ Invalid lot size."); return false; }

   // ── Portfolio (correlated) risk cap (audit MT5-05 / priority 7) ──
   double newRisk = 0;
   if (!OrderCalcProfit(orderType, symbol, lotSize, price, sl, newRisk)) newRisk = 0;
   newRisk = MathAbs(newRisk);
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double openRisk = CurrentOpenRisk();
   if (MaxPortfolioRiskPct > 0 && balance > 0 && (openRisk + newRisk) > balance * (MaxPortfolioRiskPct / 100.0)) {
      Print("[NEXUS] ⛔ Portfolio risk cap: open $", DoubleToString(openRisk, 2), " + new $", DoubleToString(newRisk, 2),
            " > ", DoubleToString(MaxPortfolioRiskPct, 1), "% of balance. Skipping.");
      return false;
   }

   MqlTradeRequest request = {};
   MqlTradeResult  result  = {};
   request.action       = TRADE_ACTION_DEAL;
   request.symbol       = symbol;
   request.volume       = lotSize;
   request.type         = orderType;
   request.price        = price;
   request.sl           = sl;
   request.tp           = tp;
   request.deviation    = SlippagePoints(symbol);
   request.magic        = MagicNumber;
   request.comment      = "NEXUS|" + sigId + "|C" + DoubleToString(conf, 0);
   request.type_filling = (ENUM_ORDER_TYPE_FILLING)PickFilling(symbol);

   bool sent = OrderSend(request, result);
   // Retry once with an alternate filling mode if rejected for that reason.
   if ((!sent || result.retcode == TRADE_RETCODE_INVALID_FILL)) {
      request.type_filling = (request.type_filling == ORDER_FILLING_IOC) ? ORDER_FILLING_FOK : ORDER_FILLING_IOC;
      sent = OrderSend(request, result);
   }

   if (!sent) {
      Print("[NEXUS] ✗ OrderSend failed: ", result.comment, " | retcode ", result.retcode, " | err ", GetLastError());
      return false;
   }
   if (result.retcode != TRADE_RETCODE_DONE && result.retcode != TRADE_RETCODE_PLACED) {
      Print("[NEXUS] ✗ Unexpected retcode: ", result.retcode, " (", result.comment, ")");
      return false;
   }

   // Resolve the TRUE position id from the deal (audit MT5-04).
   ulong posId = 0;
   if (result.deal > 0 && HistoryDealSelect(result.deal))
      posId = (ulong)HistoryDealGetInteger(result.deal, DEAL_POSITION_ID);
   if (posId == 0) posId = result.order;

   double slDist = MathAbs(price - sl);
   RegisterTrade(posId, price, sl, tp, slDist, newRisk, sigId);

   Print("[NEXUS] ═══════════════════════════════════════════");
   Print("[NEXUS] ✓ TRADE OPENED  ", symbol, " ", type);
   Print("[NEXUS]   Lots:  ", DoubleToString(lotSize, 2), " | PosID: ", posId);
   Print("[NEXUS]   Entry: ", DoubleToString(price, digits), " | SL: ", DoubleToString(sl, digits),
         " | TP: ", DoubleToString(tp, digits));
   Print("[NEXUS]   Risk:  $", DoubleToString(newRisk, 2), " | Conf: ", DoubleToString(conf, 0), "%");
   Print("[NEXUS] ═══════════════════════════════════════════");

   ReportTrade(symbol, type, lotSize, price, sl, tp, conf, sigId, posId);
   return true;
}

//+------------------------------------------------------------------+
//| REGISTER TRADE FOR MANAGEMENT                                      |
//+------------------------------------------------------------------+
void RegisterTrade(ulong posId, double entry, double sl, double tp, double riskPts, double riskMoney, string sigId)
{
   openTradeCount++;
   ArrayResize(openTrades, openTradeCount);
   int i = openTradeCount - 1;
   openTrades[i].posId        = posId;
   openTrades[i].entryPrice   = entry;
   openTrades[i].originalSL   = sl;
   openTrades[i].originalTP   = tp;
   openTrades[i].riskPoints   = riskPts;
   openTrades[i].riskMoney    = riskMoney;
   openTrades[i].sigId        = sigId;
   openTrades[i].breakEvenDone = false;
   openTrades[i].partialDone  = false;
   openTrades[i].isActive     = true;
}

double CurrentOpenRisk()
{
   double sum = 0;
   for (int i = 0; i < openTradeCount; i++)
      if (openTrades[i].isActive && PositionSelectByTicket(openTrades[i].posId))
         sum += openTrades[i].riskMoney;
   return sum;
}

//+------------------------------------------------------------------+
//| MANAGE OPEN TRADES — BE, Trailing, Partial                        |
//+------------------------------------------------------------------+
void ManageOpenTrades()
{
   for (int i = 0; i < openTradeCount; i++)
   {
      if (!openTrades[i].isActive) continue;

      if (!PositionSelectByTicket(openTrades[i].posId)) {
         // Confirm it is genuinely closed (not a transient miss) before retiring.
         if (PositionClosedInHistory(openTrades[i].posId)) openTrades[i].isActive = false;
         continue;
      }

      string symbol  = PositionGetString(POSITION_SYMBOL);
      long   posType = PositionGetInteger(POSITION_TYPE);
      double curPrice = (posType == POSITION_TYPE_BUY) ? SymbolInfoDouble(symbol, SYMBOL_BID)
                                                       : SymbolInfoDouble(symbol, SYMBOL_ASK);
      double curSL   = PositionGetDouble(POSITION_SL);
      double curTP   = PositionGetDouble(POSITION_TP);
      double point   = SymbolInfoDouble(symbol, SYMBOL_POINT);
      int    digits  = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);

      if (openTrades[i].riskPoints <= 0 || point <= 0) continue;

      double profit = (posType == POSITION_TYPE_BUY) ? (curPrice - openTrades[i].entryPrice)
                                                      : (openTrades[i].entryPrice - curPrice);
      double rMultiple = profit / openTrades[i].riskPoints;

      //--- BREAK EVEN (do this before/with partial so the runner is protected) ---
      if (UseBreakEven && !openTrades[i].breakEvenDone && rMultiple >= BreakEvenTriggerR) {
         double beLevel = (posType == POSITION_TYPE_BUY)
            ? NormalizeDouble(openTrades[i].entryPrice + BreakEvenOffsetPts * point, digits)
            : NormalizeDouble(openTrades[i].entryPrice - BreakEvenOffsetPts * point, digits);
         bool improve = (posType == POSITION_TYPE_BUY && (curSL == 0 || beLevel > curSL)) ||
                        (posType == POSITION_TYPE_SELL && (curSL == 0 || beLevel < curSL));
         if (improve && ModifySL(openTrades[i].posId, symbol, beLevel, curTP)) {
            openTrades[i].breakEvenDone = true;
            curSL = beLevel;
            Print("[NEXUS] ✓ Break-even @ ", DoubleToString(beLevel, digits), " (", DoubleToString(rMultiple, 2), "R)");
         }
      }

      //--- PARTIAL CLOSE at TP1 ---
      if (UsePartialClose && !openTrades[i].partialDone && rMultiple >= PartialCloseR &&
          (!PartialRequiresBE || openTrades[i].breakEvenDone)) {
         DoPartialClose(i, symbol, posType, curPrice, digits, rMultiple);
      }

      //--- TRAILING STOP (debounced: only act when SL improves by >= 1 point) ---
      if (UseTrailingStop && rMultiple >= TrailStartR) {
         double trailDist = TrailStepPoints * point;
         if (posType == POSITION_TYPE_BUY) {
            double newSL = NormalizeDouble(curPrice - trailDist, digits);
            if ((curSL == 0 || newSL - curSL >= point) && newSL > openTrades[i].entryPrice)
               ModifySL(openTrades[i].posId, symbol, newSL, curTP);
         } else {
            double newSL = NormalizeDouble(curPrice + trailDist, digits);
            if ((curSL == 0 || curSL - newSL >= point) && newSL < openTrades[i].entryPrice)
               ModifySL(openTrades[i].posId, symbol, newSL, curTP);
         }
      }
   }
}

void DoPartialClose(int i, string symbol, long posType, double curPrice, int digits, double rMultiple)
{
   double totalLots = PositionGetDouble(POSITION_VOLUME);
   double step      = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   double volMin    = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   if (step <= 0) step = 0.01;

   double closeLots = MathFloor((totalLots * (PartialClosePct / 100.0)) / step) * step;
   double remaining = totalLots - closeLots;
   // If the remainder would be below the broker minimum, close the whole position.
   if (remaining > 0 && remaining < volMin) closeLots = totalLots;
   if (closeLots < volMin) return;  // can't take a valid partial

   MqlTradeRequest req = {};
   MqlTradeResult  res = {};
   req.action   = TRADE_ACTION_DEAL;
   req.symbol   = symbol;
   req.volume   = closeLots;
   req.type     = (posType == POSITION_TYPE_BUY) ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
   req.price    = curPrice;
   req.deviation = SlippagePoints(symbol);
   req.magic    = MagicNumber;
   req.position = openTrades[i].posId;
   req.comment  = "NEXUS|PartialTP";
   req.type_filling = (ENUM_ORDER_TYPE_FILLING)PickFilling(symbol);

   if (OrderSend(req, res) && (res.retcode == TRADE_RETCODE_DONE || res.retcode == TRADE_RETCODE_PLACED)) {
      openTrades[i].partialDone = true;
      Print("[NEXUS] ✓ Partial close ", DoubleToString(closeLots, 2), " @ ", DoubleToString(curPrice, digits),
            " (", DoubleToString(rMultiple, 2), "R)");
   } else {
      Print("[NEXUS] ⚠ Partial close failed: retcode ", res.retcode, " err ", GetLastError());
   }
}

//+------------------------------------------------------------------+
//| MODIFY SL HELPER — checks result                                   |
//+------------------------------------------------------------------+
bool ModifySL(ulong posId, string symbol, double newSL, double tp)
{
   newSL = NormalizeDouble(newSL, (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS));
   MqlTradeRequest req = {};
   MqlTradeResult  res = {};
   req.action   = TRADE_ACTION_SLTP;
   req.symbol   = symbol;
   req.sl       = newSL;
   req.tp       = tp;
   req.position = posId;
   bool sent = OrderSend(req, res);
   if (!sent || (res.retcode != TRADE_RETCODE_DONE && res.retcode != TRADE_RETCODE_NO_CHANGES &&
                 res.retcode != TRADE_RETCODE_PLACED)) {
      static datetime lastWarn = 0;
      if (TimeCurrent() - lastWarn > 30) {
         Print("[NEXUS] ⚠ ModifySL retcode ", res.retcode, " err ", GetLastError(), " pos ", posId);
         lastWarn = TimeCurrent();
      }
      return false;
   }
   return true;
}

//+------------------------------------------------------------------+
//| LOT SIZE CALCULATION                                               |
//+------------------------------------------------------------------+
double CalculateLotSize(string symbol, double price, double sl, string type)
{
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double riskAmt = balance * (RiskPercent / 100.0);
   if (MaxRiskDollars > 0 && riskAmt > MaxRiskDollars) riskAmt = MaxRiskDollars;

   ENUM_ORDER_TYPE orderType = (type == "BUY") ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   double slDist = MathAbs(price - sl);
   if (slDist <= 0) { Print("[NEXUS] ✗ SL distance zero"); return 0; }

   double tickSize  = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);
   double tickValue = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE);
   double lotStep   = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   double minLot    = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double maxLot    = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   if (lotStep <= 0) lotStep = 0.01;

   double lots = minLot;
   if (tickSize > 0 && tickValue > 0) {
      double riskPerLot = (slDist / tickSize) * tickValue;
      if (riskPerLot > 0) lots = riskAmt / riskPerLot;
   } else {
      Print("[NEXUS] ⚠ Tick data invalid — using minimum lot.");
   }

   lots = MathFloor(lots / lotStep) * lotStep;
   lots = MathMax(lots, MathMax(minLot, MinLotSize));
   lots = MathMin(lots, MathMin(maxLot, MaxLotSize));

   // ── Margin guard ──
   double marginReq = 0;
   if (OrderCalcMargin(orderType, symbol, lots, price, marginReq)) {
      double freeMargin = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
      if (freeMargin <= 0 || marginReq > freeMargin * 0.4) {
         double safe = (freeMargin > 0 && marginReq > 0) ? lots * (freeMargin * 0.3) / marginReq : minLot;
         safe = MathFloor(safe / lotStep) * lotStep;
         safe = MathMax(safe, minLot);
         safe = MathMin(safe, MaxLotSize);
         Print("[NEXUS] ⚠ MARGIN CAP: ", DoubleToString(lots, 2), " → ", DoubleToString(safe, 2));
         lots = safe;
      }
   }

   // ── Simulated-loss cap: step DOWN until loss <= riskAmt (audit priority 7) ──
   for (int guard = 0; guard < 50; guard++) {
      double loss = 0;
      if (!OrderCalcProfit(orderType, symbol, lots, price, sl, loss)) {
         Print("[NEXUS] ⚠ OrderCalcProfit failed — capping at minimum lot.");
         lots = MathMax(minLot, MinLotSize);
         break;
      }
      loss = MathAbs(loss);
      if (loss <= riskAmt || lots <= minLot) break;
      double ratio = riskAmt / loss;
      double next = MathFloor((lots * ratio) / lotStep) * lotStep;
      if (next >= lots) next = lots - lotStep;       // guarantee progress
      lots = MathMax(next, minLot);
   }

   // Final loss check — if even minLot breaches the cap, refuse the trade.
   double finalLoss = 0;
   if (OrderCalcProfit(orderType, symbol, lots, price, sl, finalLoss)) {
      finalLoss = MathAbs(finalLoss);
      if (finalLoss > riskAmt * 1.05 && lots <= minLot) {
         Print("[NEXUS] ⛔ Even minimum lot risks $", DoubleToString(finalLoss, 2),
               " > cap $", DoubleToString(riskAmt, 2), " — refusing trade on ", symbol);
         return 0;
      }
   }

   int volDigits = VolumeDigits(lotStep);
   double finalLots = NormalizeDouble(lots, volDigits);
   Print("[NEXUS] ✓ Lot size: ", DoubleToString(finalLots, volDigits), " (risk cap $", DoubleToString(riskAmt, 2), ")");
   return finalLots;
}

int VolumeDigits(double step)
{
   if (step <= 0) return 2;
   int d = (int)MathRound(MathLog10(1.0 / step));
   if (d < 0) d = 0;
   if (d > 8) d = 8;
   return d;
}

int SlippagePoints(string symbol)
{
   // Slippage scaled to ~3x spread (min 10 pts) so fast/large-point symbols (BTC) fill.
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   if (point <= 0) return 20;
   double spreadPts = (SymbolInfoDouble(symbol, SYMBOL_ASK) - SymbolInfoDouble(symbol, SYMBOL_BID)) / point;
   int dev = (int)MathMax(10.0, spreadPts * 3.0);
   return MathMin(dev, 1000);
}

int PickFilling(string symbol)
{
   long mode = SymbolInfoInteger(symbol, SYMBOL_FILLING_MODE);
   if ((mode & SYMBOL_FILLING_FOK) != 0) return ORDER_FILLING_FOK;
   if ((mode & SYMBOL_FILLING_IOC) != 0) return ORDER_FILLING_IOC;
   return ORDER_FILLING_RETURN;
}

//+------------------------------------------------------------------+
//| HTTP HELPERS                                                       |
//+------------------------------------------------------------------+
int HttpPostJson(string url, string body, string &response)
{
   string headers = "Content-Type: application/json\r\n";
   if (StringLen(ApiKey) > 0) headers += "X-API-Key: " + ApiKey + "\r\n";
   char post[], result[];
   string resultHeaders;
   int n = StringToCharArray(body, post, 0, StringLen(body));  // no trailing NUL
   if (n < 0) return -1;
   ResetLastError();
   int code = WebRequest("POST", url, headers, 5000, post, result, resultHeaders);
   response = (ArraySize(result) > 0) ? CharArrayToString(result) : "";
   return code;
}

bool ClaimSignal(string sigId)
{
   if (!UseServerClaim) return true;
   string body = "{\"signalId\":\"" + sigId + "\",\"magic\":" + IntegerToString(MagicNumber) + "}";
   string resp = "";
   int code = HttpPostJson(API_URL + "/api/claim", body, resp);
   if (code != 200) {
      // The server's claim endpoint is the AUTHORITATIVE anti-duplicate gate — it is
      // the only layer that can see a second EA instance / chart on the same account.
      // If it is unreachable we DEFER instead of trading on local-only dedup; the
      // signal is re-evaluated next poll once the server recovers (audit XSYS-02).
      if (code == 401 || code == 403) {
         // A PERSISTENT auth failure silently halts all trading — surface it loudly
         // (rate-limited) so a token misconfig is obvious, not a mystery silence.
         static datetime lastAuthWarn = 0;
         if (TimeCurrent() - lastAuthWarn > 300) {
            Alert("[NEXUS] Claim auth failed (HTTP ", code, ") — ApiKey must match server NEXUS_API_TOKEN. NO trades until fixed.");
            lastAuthWarn = TimeCurrent();
         }
      } else {
         Print("[NEXUS] ⚠ claim HTTP ", code, " err ", GetLastError(), " — deferring (server is the dup gate)");
      }
      return false;
   }
   StringToLower(resp);
   if (StringFind(resp, "\"ok\":true") >= 0) return true;
   Print("[NEXUS] ⛔ Signal ", sigId, " not granted by server (", resp, ")");
   return false;
}

//+------------------------------------------------------------------+
//| REPORT TRADE TO DASHBOARD (with retry + offline queue)             |
//+------------------------------------------------------------------+
void ReportTrade(string symbol, string type, double lots, double price,
                 double sl, double tp, double conf, string sigId, ulong ticket)
{
   string body = "{";
   body += "\"ticket\":"     + IntegerToString((long)ticket) + ",";   // (long) — no truncation
   body += "\"symbol\":\""   + symbol + "\",";
   body += "\"type\":\""     + type + "\",";
   body += "\"lots\":"       + DoubleToString(lots, 2) + ",";
   body += "\"price\":"      + DoubleToString(price, 5) + ",";
   body += "\"sl\":"         + DoubleToString(sl, 5) + ",";
   body += "\"tp\":"         + DoubleToString(tp, 5) + ",";
   body += "\"confidence\":" + DoubleToString(conf, 0) + ",";
   body += "\"signalId\":\"" + sigId + "\",";
   body += "\"riskPct\":"    + DoubleToString(RiskPercent, 2) + ",";
   body += "\"balance\":"    + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",";
   body += "\"equity\":"     + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + ",";
   body += "\"profit\":"     + DoubleToString(AccountInfoDouble(ACCOUNT_PROFIT), 2);
   body += "}";

   string resp = "";
   int code = HttpPostJson(API_URL + "/api/trades", body, resp);
   if (code != 200) {
      code = HttpPostJson(API_URL + "/api/trades", body, resp);   // one retry
      if (code != 200) { QueueUnreported(body); Print("[NEXUS] ⚠ trade report queued (server unreachable)"); }
   }
}

//+------------------------------------------------------------------+
//| REPORT REALIZED CLOSE (per-deal P&L) — drives dashboard analytics |
//+------------------------------------------------------------------+
string SigIdForPosition(ulong posId)
{
   for (int i = 0; i < openTradeCount; i++)
      if (openTrades[i].posId == posId) return openTrades[i].sigId;
   return "";
}

void MarkTradeClosedByPos(ulong posId)
{
   for (int i = 0; i < openTradeCount; i++)
      if (openTrades[i].posId == posId) openTrades[i].isActive = false;
}

void ReportClosedTrade(string symbol, double pnl, string sigId, ulong posId, ulong dealId, bool fullyClosed)
{
   string body = "{";
   body += "\"event\":\"close\",";
   body += "\"ticket\":"     + IntegerToString((long)posId) + ",";
   body += "\"dealId\":"     + IntegerToString((long)dealId) + ",";   // unique -> idempotent
   body += "\"signalId\":\"" + sigId + "\",";
   body += "\"symbol\":\""   + symbol + "\",";
   body += "\"profit\":"     + DoubleToString(pnl, 2) + ",";          // REALIZED deal P&L
   body += "\"closed\":"     + (fullyClosed ? "true" : "false") + ",";
   body += "\"openTrades\":" + IntegerToString(CountOpenTrades()) + ",";
   body += "\"balance\":"    + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",";
   body += "\"equity\":"     + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + ",";
   body += "\"profitAcct\":" + DoubleToString(AccountInfoDouble(ACCOUNT_PROFIT), 2); // account floating P&L
   body += "}";
   string resp = "";
   int code = HttpPostJson(API_URL + "/api/trades", body, resp);
   if (code != 200) {
      code = HttpPostJson(API_URL + "/api/trades", body, resp);   // one retry
      if (code != 200) { QueueUnreported(body); Print("[NEXUS] ⚠ close report queued (server unreachable)"); }
   }
}

void QueueUnreported(string body)
{
   if (unreportedCount >= 100) return;  // bound the queue
   unreportedCount++;
   ArrayResize(unreported, unreportedCount);
   unreported[unreportedCount - 1] = body;
}

void FlushUnreported()
{
   if (unreportedCount == 0) return;
   string resp = "";
   int sent = 0;
   for (int i = 0; i < unreportedCount; i++) {
      if (HttpPostJson(API_URL + "/api/trades", unreported[i], resp) == 200) sent++;
      else break;  // still offline — stop, retry next tick
   }
   if (sent > 0) {
      // compact the queue
      for (int i = sent; i < unreportedCount; i++) unreported[i - sent] = unreported[i];
      unreportedCount -= sent;
      ArrayResize(unreported, unreportedCount);
   }
}

//+------------------------------------------------------------------+
//| HEARTBEAT TO DASHBOARD                                             |
//+------------------------------------------------------------------+
void SendHeartbeat()
{
   double dailyLoss = dayStartEquity - AccountInfoDouble(ACCOUNT_EQUITY);
   double dailyLossPct = (dayStartEquity > 0) ? (dailyLoss / dayStartEquity * 100.0) : 0;
   string body = "{";
   body += "\"balance\":"     + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",";
   body += "\"equity\":"      + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + ",";
   body += "\"profit\":"      + DoubleToString(AccountInfoDouble(ACCOUNT_PROFIT), 2) + ",";
   body += "\"openTrades\":"  + IntegerToString(CountOpenTrades()) + ",";
   body += "\"dailyLossPct\":"+ DoubleToString(dailyLossPct, 2) + ",";
   body += "\"halted\":"      + (halted ? "true" : "false") + ",";
   body += "\"session\":\""   + (IsInTradingSession() ? "ACTIVE" : "CLOSED") + "\",";
   body += "\"status\":\"CONNECTED\"";
   body += "}";
   string resp = "";
   HttpPostJson(API_URL + "/api/heartbeat", body, resp);
}

//+------------------------------------------------------------------+
//| POSITION / DEDUP UTILITIES                                         |
//+------------------------------------------------------------------+
int CountOpenTrades()
{
   int count = 0;
   for (int i = PositionsTotal() - 1; i >= 0; i--) {
      ulong t = PositionGetTicket(i);
      if (t > 0 && PositionGetInteger(POSITION_MAGIC) == MagicNumber) count++;
   }
   return count;
}

int CountOpenTradesBySymbol(string symbol)
{
   int count = 0;
   for (int i = PositionsTotal() - 1; i >= 0; i--) {
      ulong t = PositionGetTicket(i);
      if (t > 0 && PositionGetInteger(POSITION_MAGIC) == MagicNumber &&
          PositionGetString(POSITION_SYMBOL) == symbol) count++;
   }
   return count;
}

bool PositionExistsForSignal(string sigId)
{
   string needle = "NEXUS|" + sigId;
   for (int i = PositionsTotal() - 1; i >= 0; i--) {
      ulong t = PositionGetTicket(i);
      if (t > 0 && PositionGetInteger(POSITION_MAGIC) == MagicNumber) {
         if (StringFind(PositionGetString(POSITION_COMMENT), needle) >= 0) return true;
      }
   }
   return false;
}

bool PositionClosedInHistory(ulong posId)
{
   if (!HistorySelectByPosition(posId)) return false;
   int deals = HistoryDealsTotal();
   for (int i = 0; i < deals; i++) {
      ulong dt = HistoryDealGetTicket(i);
      if (dt == 0) continue;
      if (HistoryDealGetInteger(dt, DEAL_ENTRY) == DEAL_ENTRY_OUT) return true;
   }
   return false;
}

bool IsSignalExecuted(string sigId)
{
   for (int i = 0; i < executedCount; i++)
      if (executedSignals[i] == sigId) return true;
   return false;
}

void MarkSignalExecuted(string sigId)
{
   if (IsSignalExecuted(sigId)) return;
   executedCount++;
   ArrayResize(executedSignals, executedCount);
   executedSignals[executedCount - 1] = sigId;
   AppendExecutedToFile(sigId);
   if (executedCount > 500) {
      for (int i = 0; i < executedCount - 250; i++) executedSignals[i] = executedSignals[i + 250];
      executedCount -= 250;
      ArrayResize(executedSignals, executedCount);
   }
}

//+------------------------------------------------------------------+
//| EXECUTED-ID PERSISTENCE (survives restart/recompile) — MT5-01/X03 |
//+------------------------------------------------------------------+
void AppendExecutedToFile(string sigId)
{
   int h = FileOpen(ExecFileName(), FILE_READ | FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_COMMON);
   if (h == INVALID_HANDLE) return;
   FileSeek(h, 0, SEEK_END);
   FileWriteString(h, sigId + "\r\n");
   FileClose(h);
}

void LoadExecutedFromFile()
{
   int h = FileOpen(ExecFileName(), FILE_READ | FILE_TXT | FILE_ANSI | FILE_COMMON);
   if (h == INVALID_HANDLE) return;
   while (!FileIsEnding(h)) {
      string line = FileReadString(h);
      StringTrimLeft(line);
      StringTrimRight(line);
      if (StringLen(line) > 0 && !IsSignalExecuted(line)) {
         executedCount++;
         ArrayResize(executedSignals, executedCount);
         executedSignals[executedCount - 1] = line;
      }
   }
   FileClose(h);
   Print("[NEXUS] Loaded ", executedCount, " executed signal ids from ", ExecFileName());
}

//+------------------------------------------------------------------+
//| SYMBOL MAPPING + VALIDATION                                        |
//+------------------------------------------------------------------+
bool IsSymbolAllowed(string symbol)
{
   string parts[];
   int n = StringSplit(AllowedSymbols, ',', parts);
   for (int i = 0; i < n; i++) {
      StringTrimLeft(parts[i]); StringTrimRight(parts[i]);
      if (parts[i] == symbol) return true;
   }
   return false;
}

string MapSymbol(string dashSymbol)
{
   string pairs[];
   int n = StringSplit(SymbolMap, ',', pairs);
   for (int i = 0; i < n; i++) {
      string kv[];
      if (StringSplit(pairs[i], '=', kv) == 2) {
         StringTrimLeft(kv[0]); StringTrimRight(kv[0]);
         StringTrimLeft(kv[1]); StringTrimRight(kv[1]);
         if (kv[0] == dashSymbol) return kv[1];
      }
   }
   return dashSymbol;
}

void ValidateMappedSymbols()
{
   string parts[];
   int n = StringSplit(AllowedSymbols, ',', parts);
   for (int i = 0; i < n; i++) {
      StringTrimLeft(parts[i]); StringTrimRight(parts[i]);
      if (StringLen(parts[i]) == 0) continue;
      string broker = MapSymbol(parts[i]);
      if (!SymbolSelect(broker, true))
         Print("[NEXUS] ⚠ CONFIG: '", parts[i], "' maps to '", broker, "' which is NOT tradable on this broker. Fix SymbolMap.");
      else {
         int dg = (int)SymbolInfoInteger(broker, SYMBOL_DIGITS);
         double bid = SymbolInfoDouble(broker, SYMBOL_BID);
         Print("[NEXUS] ✓ ", parts[i], " → ", broker, " (digits ", dg, ", bid ", DoubleToString(bid, dg), ")");
      }
   }
}

//+------------------------------------------------------------------+
//| BOUNDED JSON EXTRACTORS — search confined to [from, upTo)         |
//+------------------------------------------------------------------+
string ExtractString(string json, string key, int from, int upTo)
{
   int keyPos = StringFind(json, key, from);
   if (keyPos < 0 || keyPos >= upTo) return "";

   int valStart = keyPos + StringLen(key);
   while (valStart < upTo) {
      ushort ch = StringGetCharacter(json, valStart);
      if (ch != ' ' && ch != ':') break;
      valStart++;
   }
   bool quoted = (valStart < upTo && StringGetCharacter(json, valStart) == '"');
   if (quoted) valStart++;

   int valEnd = valStart;
   while (valEnd < upTo) {
      ushort ch = StringGetCharacter(json, valEnd);
      if (quoted && ch == '"') break;
      if (!quoted && (ch == ',' || ch == '}' || ch == ']' || ch == ' ' || ch == '\n' || ch == '\r')) break;
      valEnd++;
   }
   if (valEnd <= valStart) return "";
   return StringSubstr(json, valStart, valEnd - valStart);
}

double ExtractDouble(string json, string key, int from, int upTo)
{
   string val = ExtractString(json, key, from, upTo);
   return (StringLen(val) > 0) ? StringToDouble(val) : 0;
}

bool ExtractBool(string json, string key, int from, int upTo)
{
   string val = ExtractString(json, key, from, upTo);
   StringToLower(val);
   return (val == "true" || val == "1");
}
//+------------------------------------------------------------------+
