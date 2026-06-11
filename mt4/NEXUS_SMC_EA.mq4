//+------------------------------------------------------------------+
//|                                              NEXUS_SMC_EA.mq4    |
//|                        NEXUS·SMC Signal Auto-Trader (MT4) v4.0   |
//|                        Connects to local API server              |
//|                                                                  |
//|  v4.0 SAFETY OVERHAUL — previously RiskPercent=70% with NO       |
//|  guards (account-blowup machine). Now brought to parity with     |
//|  the MT5 EA: 1% risk + hard ceiling, daily-loss kill-switch,     |
//|  equity/margin/portfolio guards, anti-duplicate (server claim +  |
//|  persisted ids + open-order scan + optimistic mark), directional |
//|  + stops-level + price-divergence guards, spread/session filters, |
//|  BE/trailing/partial management, and trade reporting.            |
//+------------------------------------------------------------------+
#property copyright "NEXUS·SMC Trading System"
#property version   "4.00"
#property description "Auto-executes SMC signals with hardened risk management (MT4)"
#property strict

//--- API CONNECTION ---
input string  API_URL          = "http://127.0.0.1:3001";  // API Server URL
input int     PollSeconds      = 3;                         // Poll interval (seconds)
input string  ApiKey           = "";                        // Shared secret (X-API-Key) if server token set
input bool    UseServerClaim   = true;                      // Lease each signal before trading (anti-duplicate)

//--- RISK MANAGEMENT ---  ← MOST CRITICAL
input double  RiskPercent      = 1.0;     // Risk % per trade (RECOMMENDED 0.5–2.0%)
input double  MaxRiskPercentHard = 5.0;   // Refuse to start if RiskPercent above this
input double  MaxDailyLossPercent = 5.0;  // Max daily loss % (vs day-start equity) before halt
input double  MaxLotSize       = 0.05;    // Hard max lot size cap
input double  MinLotSize       = 0.01;    // Minimum lot size
input double  MaxRiskDollars   = 20.0;    // Absolute max $ risk per trade (0 = disabled)
input double  MaxPortfolioRiskPct = 3.0;  // Max combined open risk (% of balance)
input int     MaxOpenTrades    = 3;       // Max simultaneous trades
input int     MaxTradesPerSymbol = 1;     // Max simultaneous trades per symbol
input int     MaxTradesPerDay   = 10;     // Max NEW trades per day (0 = unlimited)
input int     MaxConsecutiveLosses = 4;   // Halt after N losing closes in a row (0 = off)
input double  EquityGuardPct   = 0.85;    // No new trades if equity < this fraction of balance
input double  MinFreeMarginPct = 0.15;    // No new trades if free margin < this fraction of balance

//--- ENTRY FILTERS ---
input int     MinConfidence    = 80;      // Minimum signal confidence %
input double  MaxSpreadPoints  = 0.0;     // Max spread (points); 0 = use spread/SL ratio gate
input double  MaxSpreadToSLRatio = 0.20;  // Reject if spread > this fraction of SL distance
input double  MaxEntryDeviation = 15.0;   // Max % of SL distance price may stray from signal entry
input double  MaxPriceDivergencePct = 1.0;// Reject if broker price differs from signal price by > this %
input bool    SessionFilterEnabled = true;// Only trade London/NY sessions
input int     LondonOpenHour   = 7;
input int     LondonCloseHour  = 16;
input int     NewYorkOpenHour  = 13;
input int     NewYorkCloseHour = 21;

//--- SMC CONFLUENCE ---
input bool    RequireOBProximity = true;  // Only trade if price near the signal entry
input double  OBProximityPct    = 0.3;    // Fraction of SL distance
input bool    RequireFVGFill    = false;
input bool    RequireLiquiditySweep = false;

//--- TRADE MANAGEMENT ---
input bool    UseBreakEven     = true;
input double  BreakEvenTriggerR = 1.0;
input double  BreakEvenOffsetPts = 5.0;
input bool    UseTrailingStop  = true;
input double  TrailStartR      = 1.5;
input double  TrailStepPoints  = 15.0;
input bool    UsePartialClose  = true;
input double  PartialCloseR    = 1.0;
input double  PartialClosePct  = 50.0;
input bool    PartialRequiresBE = true;

//--- EA IDENTITY ---
input int     MagicNumber      = 20260515;
input bool    TradeEnabled     = true;
input bool    AllowConfidenceOverride = false;
input int     OverrideConf      = 90;
input string  AllowedSymbols   = "BTCUSD,EURUSDT,Nasdaq";
input string  SymbolMap        = "BTCUSD=BTCUSD,EURUSDT=EURUSDT,Nasdaq=Nasdaq";

//--- Internal state ---
string   executedSignals[];
int      executedCount = 0;
string   partialedSigs[];
int      partialedCount = 0;
string   mgSig[];                 // signal id -> original risk distance (survives ticket changes)
double   mgRisk[];
int      mgCount = 0;
string   unreported[];
int      unreportedCount = 0;
int      openTickets[];           // tickets opened this session (for realized-close reporting)
string   openTicketSig[];         // parallel: signal id per tracked ticket
int      openTicketCount = 0;
datetime lastPoll = 0;

double   dayStartEquity = 0;
int      currentDayKey  = 0;
int      tradesToday    = 0;
int      consecLosses   = 0;
bool     halted         = false;

//+------------------------------------------------------------------+
string GV(string s) { return "NEXUS_" + IntegerToString(MagicNumber) + "_" + s; }
string ExecFileName() { return "NEXUS_executed_" + IntegerToString(MagicNumber) + ".csv"; }
int TodayKey() { MqlDateTime dt; TimeToStruct(TimeCurrent(), dt); return dt.year*10000 + dt.mon*100 + dt.day; }

//+------------------------------------------------------------------+
int OnInit()
{
   if (RiskPercent > MaxRiskPercentHard) {
      Alert("[NEXUS] REFUSING TO START: RiskPercent ", RiskPercent, "% > hard ceiling ", MaxRiskPercentHard, "%.");
      return(INIT_PARAMETERS_INCORRECT);
   }
   if (RiskPercent <= 0 || MinLotSize <= 0 || MaxLotSize < MinLotSize) {
      Alert("[NEXUS] REFUSING TO START: invalid risk/lot configuration.");
      return(INIT_PARAMETERS_INCORRECT);
   }

   SyncDay();
   LoadExecutedFromFile();
   ValidateMappedSymbols();

   Print("╔══════════════════════════════════════════╗");
   Print("║   NEXUS·SMC EA v4.0 (MT4) Initialized    ║");
   Print("║   Risk: ", DoubleToString(RiskPercent, 2), "% | Max $: ", DoubleToString(MaxRiskDollars, 2),
         " | Daily Loss: ", DoubleToString(MaxDailyLossPercent, 1), "%");
   Print("║   Dedup: claim=", (UseServerClaim?"ON":"OFF"), " persisted ids: ", executedCount,
         " | halt: ", (halted?"ACTIVE":"clear"));
   Print("╚══════════════════════════════════════════╝");

   EventSetTimer(PollSeconds);
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   Print("[NEXUS] EA Stopped. Reason: ", reason);
}

//+------------------------------------------------------------------+
void OnTimer()
{
   CheckDayRollover();
   ManageOpenTrades();
   SyncOpenTickets();        // pick up partial-close remainders / restart orphans
   CheckClosedTrades();      // report realized P&L for any that closed
   UpdateConsecutiveLosses();
   FlushUnreported();

   if (!TradeEnabled)         { SendHeartbeat(); return; }
   if (halted)                { SendHeartbeat(); return; }
   if (IsDailyLossBreached())  { TripHalt("daily loss limit reached"); SendHeartbeat(); return; }
   if (!IsEquitySafe())        { SendHeartbeat(); return; }
   if (MaxTradesPerDay > 0 && tradesToday >= MaxTradesPerDay) { SendHeartbeat(); return; }

   PollSignals();
   SendHeartbeat();
}

void OnTick()
{
   ManageOpenTrades();   // poll is timer-only to avoid duplicate races
}

//+------------------------------------------------------------------+
//| DAILY TRACKING + STICKY HALT                                       |
//+------------------------------------------------------------------+
void SyncDay()
{
   int key = TodayKey();
   if (GlobalVariableCheck(GV("dayKey")) && (int)GlobalVariableGet(GV("dayKey")) == key) {
      dayStartEquity = GlobalVariableGet(GV("dayStartEq"));
      if (dayStartEquity <= 0) dayStartEquity = AccountEquity();
      tradesToday  = (int)GlobalVariableGet(GV("tradesToday"));
      halted       = (GlobalVariableCheck(GV("halt")) && GlobalVariableGet(GV("halt")) > 0);
   } else {
      dayStartEquity = AccountEquity();
      tradesToday = 0;
      halted = false;
      GlobalVariableSet(GV("dayKey"), key);
      GlobalVariableSet(GV("dayStartEq"), dayStartEquity);
      GlobalVariableSet(GV("tradesToday"), 0);
      if (GlobalVariableCheck(GV("halt"))) GlobalVariableDel(GV("halt"));
   }
   currentDayKey = key;
}

void CheckDayRollover()
{
   if (TodayKey() != currentDayKey) {
      SyncDay();
      Print("[NEXUS] New trading day. Day-start equity: $", DoubleToString(dayStartEquity, 2));
   }
}

bool IsDailyLossBreached()
{
   double maxLoss = dayStartEquity * (MaxDailyLossPercent / 100.0);
   return ((dayStartEquity - AccountEquity()) >= maxLoss);
}

void TripHalt(string reason)
{
   if (halted) return;
   halted = true;
   GlobalVariableSet(GV("halt"), 1);
   Print("[NEXUS] ⛔⛔ HALT: ", reason, ". No NEW trades until next day or manual reset of ", GV("halt"));
}

bool IsEquitySafe()
{
   double balance = AccountBalance();
   double equity  = AccountEquity();
   double freeM   = AccountFreeMargin();
   if (balance > 0 && equity < balance * EquityGuardPct) {
      static datetime m1 = 0;
      if (TimeCurrent() - m1 > 300) { Print("[NEXUS] ⛔ EQUITY GUARD: eq $", DoubleToString(equity,2), " < ", DoubleToString(EquityGuardPct*100,0), "% of bal $", DoubleToString(balance,2)); m1 = TimeCurrent(); }
      return false;
   }
   double minFree = MathMax(balance * MinFreeMarginPct, 50.0);
   if (freeM < minFree) {
      static datetime m2 = 0;
      if (TimeCurrent() - m2 > 300) { Print("[NEXUS] ⛔ MARGIN GUARD: free $", DoubleToString(freeM,2), " < $", DoubleToString(minFree,2)); m2 = TimeCurrent(); }
      return false;
   }
   return true;
}

//+------------------------------------------------------------------+
//| CONSECUTIVE-LOSS TRACKER (scans closed history for this magic)     |
//+------------------------------------------------------------------+
void UpdateConsecutiveLosses()
{
   // Count the most-recent run of losing closes for this magic. MT4 history index
   // order is NOT guaranteed chronological, so collect ALL this-magic closes, then
   // walk them in true close-time order (most-recent first) until a non-loss ends
   // the streak. Bounded to maxSteps passes (we only need one past the threshold),
   // so it stays O(maxSteps * n) regardless of history size — and never excludes
   // the genuinely-latest closes the way a pre-sort index cap could.
   int total = OrdersHistoryTotal();
   datetime times[];
   double   nets[];
   int n = 0;
   for (int i = total - 1; i >= 0; i--) {
      if (!OrderSelect(i, SELECT_BY_POS, MODE_HISTORY)) continue;
      if (OrderMagicNumber() != MagicNumber) continue;
      if (OrderType() != OP_BUY && OrderType() != OP_SELL) continue;  // skip cancelled pendings
      ArrayResize(times, n + 1);
      ArrayResize(nets,  n + 1);
      times[n] = OrderCloseTime();
      nets[n]  = OrderProfit() + OrderSwap() + OrderCommission();
      n++;
   }

   int maxSteps = (MaxConsecutiveLosses > 0) ? MaxConsecutiveLosses + 1 : 64;
   if (maxSteps > n) maxSteps = n;
   bool used[];
   ArrayResize(used, n);
   for (int i = 0; i < n; i++) used[i] = false;

   int run = 0;
   for (int step = 0; step < maxSteps; step++) {
      int idx = -1;
      datetime best = -1;
      for (int i = 0; i < n; i++) {                 // pick the next most-recent close
         if (used[i]) continue;
         if (times[i] > best) { best = times[i]; idx = i; }
      }
      if (idx < 0) break;
      used[idx] = true;
      if (nets[idx] < 0) run++;
      else break;                                   // a win/break-even ends the streak
   }
   consecLosses = run;
   if (MaxConsecutiveLosses > 0 && consecLosses >= MaxConsecutiveLosses)
      TripHalt("max consecutive losses (" + IntegerToString(consecLosses) + ")");
}

//+------------------------------------------------------------------+
//| SESSION / SPREAD / ENTRY FILTERS                                   |
//+------------------------------------------------------------------+
bool IsInTradingSession()
{
   if (!SessionFilterEnabled) return true;
   MqlDateTime dt; TimeToStruct(TimeCurrent(), dt);
   int h = dt.hour;
   return ((h >= LondonOpenHour && h < LondonCloseHour) || (h >= NewYorkOpenHour && h < NewYorkCloseHour));
}

bool IsSpreadAcceptable(string symbol, double slDist)
{
   double ask = MarketInfo(symbol, MODE_ASK);
   double bid = MarketInfo(symbol, MODE_BID);
   double point = MarketInfo(symbol, MODE_POINT);
   if (point <= 0) return false;
   double spread = ask - bid;
   if (MaxSpreadPoints > 0 && (spread / point) > MaxSpreadPoints) {
      Print("[NEXUS] ⚠ Spread ", DoubleToString(spread/point,1), " pts > max on ", symbol); return false;
   }
   if (MaxSpreadToSLRatio > 0 && slDist > 0 && spread > slDist * MaxSpreadToSLRatio) {
      Print("[NEXUS] ⚠ Spread too wide vs SL distance on ", symbol); return false;
   }
   return true;
}

bool IsPriceCloseToSignal(string symbol, string type, double signalEntry, double sl)
{
   bool proximityOn = RequireOBProximity;
   bool deviationOn = (MaxEntryDeviation > 0);
   if (!proximityOn && !deviationOn) proximityOn = true;

   double price = (type == "BUY") ? MarketInfo(symbol, MODE_ASK) : MarketInfo(symbol, MODE_BID);
   double slDist = MathAbs(signalEntry - sl);
   if (slDist <= 0) return false;
   double delta = MathAbs(price - signalEntry);

   if (deviationOn && delta > slDist * (MaxEntryDeviation / 100.0)) {
      Print("[NEXUS] ⚠ Price strayed too far from entry on ", symbol); return false;
   }
   if (proximityOn && delta > slDist * OBProximityPct) {
      Print("[NEXUS] ⚠ Price not at POI on ", symbol); return false;
   }
   return true;
}

bool IsPriceConsistent(string symbol, double signalEntry)
{
   if (MaxPriceDivergencePct <= 0 || signalEntry <= 0) return true;
   double bid = MarketInfo(symbol, MODE_BID);
   if (bid <= 0) return false;
   double div = MathAbs(bid - signalEntry) / signalEntry * 100.0;
   if (div > MaxPriceDivergencePct) {
      Print("[NEXUS] ⛔ Price divergence ", DoubleToString(div,2), "% (broker ", DoubleToString(bid,5),
            " vs signal ", DoubleToString(signalEntry,5), ") on ", symbol, " — wrong instrument? Skipping.");
      return false;
   }
   return true;
}

bool PassesSMCFilters(bool hasFVG, bool hasLiqSweep)
{
   if (RequireFVGFill && !hasFVG) return false;
   if (RequireLiquiditySweep && !hasLiqSweep) return false;
   return true;
}

//+------------------------------------------------------------------+
//| POLL + PROCESS SIGNALS                                             |
//+------------------------------------------------------------------+
void PollSignals()
{
   lastPoll = TimeCurrent();
   if (!IsInTradingSession()) return;

   string url = API_URL + "/api/signals?min_confidence=" + IntegerToString(MinConfidence) + "&status=ACTIVE";
   string cookie = NULL, resultHeaders;
   char post[], result[];
   ResetLastError();
   int httpCode = WebRequest("GET", url, cookie, NULL, 5000, post, 0, result, resultHeaders);
   if (httpCode != 200) {
      int err = GetLastError();
      if (err == 4014) Print("[NEXUS] ⛔ Allow WebRequest for '", API_URL, "' in Tools>Options>Expert Advisors");
      else Print("[NEXUS] API Error: HTTP ", httpCode, " | err ", err);
      return;
   }
   ProcessSignals(CharArrayToString(result));
}

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

      if (StringLen(sigId) == 0 || StringLen(sigSymbol) == 0) continue;
      if (sigType != "BUY" && sigType != "SELL")              continue;
      if (sigConf < MinConfidence)                            continue;
      if (sigStatus != "ACTIVE")                              continue;
      if (sigSL <= 0 || sigTP <= 0 || sigEntry <= 0)          continue;
      if (IsSignalExecuted(sigId))                            continue;
      if (!IsSymbolAllowed(sigSymbol))                        continue;

      string brokerSym = MapSymbol(sigSymbol);
      if (MarketInfo(brokerSym, MODE_BID) <= 0) { Print("[NEXUS] Symbol unavailable: ", brokerSym); continue; }

      if (PositionExistsForSignal(sigId)) { MarkSignalExecuted(sigId); continue; }

      int allowed = MaxTradesPerSymbol;
      if (AllowConfidenceOverride && sigConf >= OverrideConf) allowed += 1;
      if (CountOpenTradesBySymbol(brokerSym) >= allowed) continue;

      Print("[NEXUS] Signal ", sigId, " | ", sigType, " ", brokerSym, " | Conf ", DoubleToString(sigConf,0), "%");

      if (!IsPriceConsistent(brokerSym, sigEntry))                     continue;
      double slDistGuess = MathAbs(sigEntry - sigSL);
      if (!IsSpreadAcceptable(brokerSym, slDistGuess))                continue;
      if (!IsPriceCloseToSignal(brokerSym, sigType, sigEntry, sigSL)) continue;
      if (!PassesSMCFilters(hasFVG, hasLiqSweep))                     continue;

      if (!ClaimSignal(sigId)) continue;
      MarkSignalExecuted(sigId);   // optimistic, before OrderSend

      if (ExecuteTrade(brokerSym, sigType, sigEntry, sigSL, sigTP, sigConf, sigId)) {
         currentOpen++;
         tradesToday++;
         GlobalVariableSet(GV("tradesToday"), tradesToday);
      } else {
         Print("[NEXUS] Execution failed for ", sigId, " (left marked).");
      }
   }
}

//+------------------------------------------------------------------+
//| EXECUTE TRADE (MT4)                                                |
//+------------------------------------------------------------------+
bool ExecuteTrade(string symbol, string type, double entry, double sl, double tp, double conf, string sigId)
{
   int cmd = (type == "BUY") ? OP_BUY : OP_SELL;
   RefreshRates();
   double price = (type == "BUY") ? MarketInfo(symbol, MODE_ASK) : MarketInfo(symbol, MODE_BID);
   if (price <= 0) { Print("[NEXUS] ✗ Invalid price ", symbol); return false; }

   int digits = (int)MarketInfo(symbol, MODE_DIGITS);
   double point = MarketInfo(symbol, MODE_POINT);
   sl = NormalizeDouble(sl, digits);
   tp = NormalizeDouble(tp, digits);

   // Directional sanity vs actual price
   if (type == "BUY"  && !(sl < price && tp > price)) { Print("[NEXUS] ✗ BUY SL/TP not bracketing price"); return false; }
   if (type == "SELL" && !(sl > price && tp < price)) { Print("[NEXUS] ✗ SELL SL/TP not bracketing price"); return false; }

   // Broker minimum stop distance
   double stopLevel = MarketInfo(symbol, MODE_STOPLEVEL) * point;
   if (stopLevel > 0 && (MathAbs(price - sl) < stopLevel || MathAbs(tp - price) < stopLevel)) {
      Print("[NEXUS] ✗ SL/TP inside broker stop level on ", symbol); return false;
   }

   double lots = CalculateLotSize(symbol, price, sl);
   if (lots <= 0) { Print("[NEXUS] ✗ Invalid lot size"); return false; }

   // Portfolio risk cap
   double newRisk = EstimateRisk(symbol, price, sl, lots);
   double openRisk = CurrentOpenRisk();
   double balance = AccountBalance();
   if (MaxPortfolioRiskPct > 0 && balance > 0 && (openRisk + newRisk) > balance * (MaxPortfolioRiskPct/100.0)) {
      Print("[NEXUS] ⛔ Portfolio risk cap exceeded (open $", DoubleToString(openRisk,2), " + new $", DoubleToString(newRisk,2), ")");
      return false;
   }

   int slippage = SlippagePoints(symbol);
   string comment = "NEXUS|" + sigId + "|C" + DoubleToString(conf, 0);

   int ticket = -1;
   for (int attempt = 0; attempt < 2; attempt++) {
      RefreshRates();
      price = (type == "BUY") ? MarketInfo(symbol, MODE_ASK) : MarketInfo(symbol, MODE_BID);
      ticket = OrderSend(symbol, cmd, lots, NormalizeDouble(price, digits), slippage, sl, tp, comment, MagicNumber, 0,
                         (type == "BUY") ? clrGreen : clrRed);
      if (ticket > 0) break;
      int err = GetLastError();
      if (err == 135 || err == 138 || err == 136) { Sleep(300); continue; } // requote/price change/off quotes
      break;
   }

   if (ticket > 0) {
      Print("[NEXUS] ═══════════════════════════════════════");
      Print("[NEXUS] ✓ ORDER EXECUTED  ", symbol, " ", type);
      Print("[NEXUS]   Lots: ", DoubleToString(lots,2), " | Ticket: ", ticket);
      Print("[NEXUS]   Entry: ", DoubleToString(price,digits), " | SL: ", DoubleToString(sl,digits), " | TP: ", DoubleToString(tp,digits));
      Print("[NEXUS]   Risk: $", DoubleToString(newRisk,2), " | Conf: ", DoubleToString(conf,0), "%");
      Print("[NEXUS] ═══════════════════════════════════════");
      ReportTrade(symbol, type, lots, price, sl, tp, conf, sigId, ticket);
      RegisterOpenTicket(ticket, sigId);   // track for realized-close reporting
      return true;
   }
   Print("[NEXUS] ✗ OrderSend failed err ", GetLastError(), " ", symbol, " ", type, " lots ", DoubleToString(lots,2));
   return false;
}

//+------------------------------------------------------------------+
//| LOT SIZE (MT4)                                                     |
//+------------------------------------------------------------------+
double EstimateRisk(string symbol, double price, double sl, double lots)
{
   double tickSize  = MarketInfo(symbol, MODE_TICKSIZE);
   double tickValue = MarketInfo(symbol, MODE_TICKVALUE);
   double slDist = MathAbs(price - sl);
   if (tickSize <= 0 || tickValue <= 0) return 0;
   return (slDist / tickSize) * tickValue * lots;
}

double CalculateLotSize(string symbol, double price, double sl)
{
   double balance = AccountBalance();
   double riskAmt = balance * (RiskPercent / 100.0);
   if (MaxRiskDollars > 0 && riskAmt > MaxRiskDollars) riskAmt = MaxRiskDollars;

   double slDist = MathAbs(price - sl);
   if (slDist <= 0) return 0;

   double tickSize  = MarketInfo(symbol, MODE_TICKSIZE);
   double tickValue = MarketInfo(symbol, MODE_TICKVALUE);
   double lotStep   = MarketInfo(symbol, MODE_LOTSTEP);
   double minLot    = MarketInfo(symbol, MODE_MINLOT);
   double maxLot    = MarketInfo(symbol, MODE_MAXLOT);
   if (lotStep <= 0) lotStep = 0.01;
   if (tickSize <= 0 || tickValue <= 0) { Print("[NEXUS] ⚠ Tick data invalid — minimum lot."); return MathMax(minLot, MinLotSize); }

   double riskPerLot = (slDist / tickSize) * tickValue;
   if (riskPerLot <= 0) return MathMax(minLot, MinLotSize);

   double lots = riskAmt / riskPerLot;
   lots = MathFloor(lots / lotStep) * lotStep;
   lots = MathMax(lots, MathMax(minLot, MinLotSize));
   lots = MathMin(lots, MathMin(maxLot, MaxLotSize));

   // Margin guard via AccountFreeMarginCheck (negative => not enough margin)
   double freeAfter = AccountFreeMarginCheck(symbol, OP_BUY, lots);
   if (freeAfter <= 0 || GetLastError() == 134) {
      while (lots > minLot && (AccountFreeMarginCheck(symbol, OP_BUY, lots) <= 0)) lots -= lotStep;
      lots = MathMax(lots, minLot);
   }

   // Simulated-loss cap: step down until loss <= riskAmt
   for (int g = 0; g < 50; g++) {
      double loss = riskPerLot * lots;
      if (loss <= riskAmt || lots <= minLot) break;
      double next = MathFloor((riskAmt / riskPerLot) / lotStep) * lotStep;
      if (next >= lots) next = lots - lotStep;
      lots = MathMax(next, minLot);
   }
   if (riskPerLot * lots > riskAmt * 1.05 && lots <= minLot) {
      Print("[NEXUS] ⛔ Even min lot risks more than cap on ", symbol, " — refusing trade.");
      return 0;
   }

   int volDigits = VolumeDigits(lotStep);
   return NormalizeDouble(lots, volDigits);
}

int VolumeDigits(double step)
{
   if (step <= 0) return 2;
   int d = (int)MathRound(MathLog10(1.0 / step));
   if (d < 0) d = 0; if (d > 8) d = 8;
   return d;
}

int SlippagePoints(string symbol)
{
   double point = MarketInfo(symbol, MODE_POINT);
   if (point <= 0) return 30;
   double spreadPts = (MarketInfo(symbol, MODE_ASK) - MarketInfo(symbol, MODE_BID)) / point;
   int dev = (int)MathMax(10.0, spreadPts * 3.0);
   return (int)MathMin(dev, 1000);
}

//+------------------------------------------------------------------+
//| MANAGE OPEN TRADES (BE / Trailing / Partial)                       |
//+------------------------------------------------------------------+
void ManageOpenTrades()
{
   for (int i = OrdersTotal() - 1; i >= 0; i--) {
      if (!OrderSelect(i, SELECT_BY_POS, MODE_TRADES)) continue;
      if (OrderMagicNumber() != MagicNumber) continue;
      if (OrderType() != OP_BUY && OrderType() != OP_SELL) continue;

      string symbol = OrderSymbol();
      int    digits = (int)MarketInfo(symbol, MODE_DIGITS);
      double point  = MarketInfo(symbol, MODE_POINT);
      double entry  = OrderOpenPrice();
      double curSL  = OrderStopLoss();
      double curTP  = OrderTakeProfit();
      bool   isBuy  = (OrderType() == OP_BUY);
      double cur    = isBuy ? MarketInfo(symbol, MODE_BID) : MarketInfo(symbol, MODE_ASK);
      if (point <= 0) continue;

      // Approximate risk distance from the (current) SL if present, else skip mgmt.
      double riskDist = (curSL > 0) ? MathAbs(entry - curSL) : 0;
      if (riskDist <= 0) continue;
      double profit = isBuy ? (cur - entry) : (entry - cur);
      double R = profit / riskDist;
      string sigId = ParseSigId(OrderComment());

      // BREAK EVEN
      bool beDone = isBuy ? (curSL >= entry) : (curSL > 0 && curSL <= entry);
      if (UseBreakEven && !beDone && R >= BreakEvenTriggerR) {
         double be = isBuy ? NormalizeDouble(entry + BreakEvenOffsetPts*point, digits)
                           : NormalizeDouble(entry - BreakEvenOffsetPts*point, digits);
         bool improve = isBuy ? (curSL == 0 || be > curSL) : (curSL == 0 || be < curSL);
         if (improve && OrderModify(OrderTicket(), entry, be, curTP, 0, clrYellow)) {
            curSL = be; beDone = true;
            Print("[NEXUS] ✓ BE @ ", DoubleToString(be,digits), " (", DoubleToString(R,2), "R)");
         }
      }

      // PARTIAL CLOSE (keyed by signal id so a ticket change can't double it)
      if (UsePartialClose && R >= PartialCloseR && (!PartialRequiresBE || beDone) && !IsPartialed(sigId)) {
         double lotStep = MarketInfo(symbol, MODE_LOTSTEP); if (lotStep <= 0) lotStep = 0.01;
         double minLot  = MarketInfo(symbol, MODE_MINLOT);
         double lots    = OrderLots();
         double closeLots = MathFloor((lots * (PartialClosePct/100.0)) / lotStep) * lotStep;
         double remaining = lots - closeLots;
         if (remaining > 0 && remaining < minLot) closeLots = lots;
         if (closeLots >= minLot) {
            double cp = isBuy ? MarketInfo(symbol, MODE_BID) : MarketInfo(symbol, MODE_ASK);
            if (OrderClose(OrderTicket(), closeLots, NormalizeDouble(cp,digits), SlippagePoints(symbol), clrAqua)) {
               MarkPartialed(sigId);
               Print("[NEXUS] ✓ Partial ", DoubleToString(closeLots,2), " @ ", DoubleToString(cp,digits), " (", DoubleToString(R,2), "R)");
               continue;  // ticket may have changed; re-scan next pass
            } else {
               Print("[NEXUS] ⚠ Partial close failed err ", GetLastError());
            }
         }
      }

      // TRAILING STOP (debounced)
      if (UseTrailingStop && R >= TrailStartR) {
         double trail = TrailStepPoints * point;
         if (isBuy) {
            double newSL = NormalizeDouble(cur - trail, digits);
            if ((curSL == 0 || newSL - curSL >= point) && newSL > entry)
               OrderModify(OrderTicket(), entry, newSL, curTP, 0, clrOrange);
         } else {
            double newSL = NormalizeDouble(cur + trail, digits);
            if ((curSL == 0 || curSL - newSL >= point) && newSL < entry)
               OrderModify(OrderTicket(), entry, newSL, curTP, 0, clrOrange);
         }
      }
   }
}

double CurrentOpenRisk()
{
   double sum = 0;
   for (int i = OrdersTotal() - 1; i >= 0; i--) {
      if (!OrderSelect(i, SELECT_BY_POS, MODE_TRADES)) continue;
      if (OrderMagicNumber() != MagicNumber) continue;
      if (OrderType() != OP_BUY && OrderType() != OP_SELL) continue;
      if (OrderStopLoss() <= 0) continue;
      sum += EstimateRisk(OrderSymbol(), OrderOpenPrice(), OrderStopLoss(), OrderLots());
   }
   return sum;
}

//+------------------------------------------------------------------+
//| HTTP HELPERS                                                       |
//+------------------------------------------------------------------+
int HttpPostJson(string url, string body, string &response)
{
   string headers = "Content-Type: application/json\r\n";
   if (StringLen(ApiKey) > 0) headers += "X-API-Key: " + ApiKey + "\r\n";
   char post[], result[]; string resultHeaders;
   int n = StringToCharArray(body, post, 0, StringLen(body));
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
   // The server claim endpoint is the authoritative anti-duplicate gate (only layer
   // that can see a second EA/chart on the same account). If unreachable, DEFER
   // rather than trade on local-only dedup; the signal retries next poll.
   if (code != 200) {
      if (code == 401 || code == 403) {
         static datetime lastAuthWarn = 0;
         if (TimeCurrent() - lastAuthWarn > 300) {
            Alert("[NEXUS] Claim auth failed (HTTP ", code, ") — ApiKey must match server NEXUS_API_TOKEN. NO trades until fixed.");
            lastAuthWarn = TimeCurrent();
         }
      } else {
         Print("[NEXUS] ⚠ claim HTTP ", code, " — deferring (server is the dup gate)");
      }
      return false;
   }
   StringToLower(resp);
   if (StringFind(resp, "\"ok\":true") >= 0) return true;
   Print("[NEXUS] ⛔ Signal ", sigId, " not granted (", resp, ")");
   return false;
}

void ReportTrade(string symbol, string type, double lots, double price, double sl, double tp, double conf, string sigId, int ticket)
{
   string body = "{";
   body += "\"ticket\":"     + IntegerToString(ticket) + ",";
   body += "\"symbol\":\""   + symbol + "\",";
   body += "\"type\":\""     + type + "\",";
   body += "\"lots\":"       + DoubleToString(lots,2) + ",";
   body += "\"price\":"      + DoubleToString(price,5) + ",";
   body += "\"sl\":"         + DoubleToString(sl,5) + ",";
   body += "\"tp\":"         + DoubleToString(tp,5) + ",";
   body += "\"confidence\":" + DoubleToString(conf,0) + ",";
   body += "\"signalId\":\"" + sigId + "\",";
   body += "\"riskPct\":"    + DoubleToString(RiskPercent,2) + ",";
   body += "\"balance\":"    + DoubleToString(AccountBalance(),2) + ",";
   body += "\"equity\":"     + DoubleToString(AccountEquity(),2) + ",";
   body += "\"profit\":"     + DoubleToString(AccountProfit(),2);
   body += "}";
   string resp = "";
   int code = HttpPostJson(API_URL + "/api/trades", body, resp);
   if (code != 200) {
      code = HttpPostJson(API_URL + "/api/trades", body, resp);
      if (code != 200) { QueueUnreported(body); Print("[NEXUS] ⚠ trade report queued"); }
   }
}

void QueueUnreported(string body)
{
   if (unreportedCount >= 100) return;
   unreportedCount++;
   ArrayResize(unreported, unreportedCount);
   unreported[unreportedCount - 1] = body;
}

void FlushUnreported()
{
   if (unreportedCount == 0) return;
   string resp = ""; int sent = 0;
   for (int i = 0; i < unreportedCount; i++) {
      if (HttpPostJson(API_URL + "/api/trades", unreported[i], resp) == 200) sent++;
      else break;
   }
   if (sent > 0) {
      for (int i = sent; i < unreportedCount; i++) unreported[i - sent] = unreported[i];
      unreportedCount -= sent;
      ArrayResize(unreported, unreportedCount);
   }
}

//+------------------------------------------------------------------+
//| REALIZED-CLOSE REPORTING (MT4 has no OnTradeTransaction)           |
//| Track our open tickets; when one closes, report its realized P&L. |
//+------------------------------------------------------------------+
bool IsOpenTicketTracked(int ticket)
{
   for (int i = 0; i < openTicketCount; i++) if (openTickets[i] == ticket) return true;
   return false;
}

void RegisterOpenTicket(int ticket, string sigId)
{
   if (IsOpenTicketTracked(ticket)) return;
   openTicketCount++;
   ArrayResize(openTickets, openTicketCount);
   ArrayResize(openTicketSig, openTicketCount);
   openTickets[openTicketCount - 1]   = ticket;
   openTicketSig[openTicketCount - 1] = sigId;
}

void RemoveOpenTicketAt(int idx)
{
   for (int j = idx; j < openTicketCount - 1; j++) {
      openTickets[j]   = openTickets[j + 1];
      openTicketSig[j] = openTicketSig[j + 1];
   }
   openTicketCount--;
   ArrayResize(openTickets, openTicketCount);
   ArrayResize(openTicketSig, openTicketCount);
}

// Register any currently-open magic order we aren't already tracking
// (captures partial-close remainder tickets and positions left open across restart).
void SyncOpenTickets()
{
   for (int i = OrdersTotal() - 1; i >= 0; i--) {
      if (!OrderSelect(i, SELECT_BY_POS, MODE_TRADES)) continue;
      if (OrderMagicNumber() != MagicNumber) continue;
      if (OrderType() != OP_BUY && OrderType() != OP_SELL) continue;
      int tk = OrderTicket();
      if (!IsOpenTicketTracked(tk)) RegisterOpenTicket(tk, ParseSigId(OrderComment()));
   }
}

void CheckClosedTrades()
{
   for (int i = openTicketCount - 1; i >= 0; i--) {
      int ticket = openTickets[i];
      string sigId = openTicketSig[i];
      if (!OrderSelect(ticket, SELECT_BY_TICKET)) { RemoveOpenTicketAt(i); continue; }
      if (OrderCloseTime() == 0) continue;   // still open
      double pnl = OrderProfit() + OrderSwap() + OrderCommission();
      string sym = OrderSymbol();
      // In MT4 a partial close sends the ORIGINAL ticket to history and opens a NEW
      // remainder ticket under the same signal-id comment. So this is the trade's
      // FINAL exit only if no other open order still carries this signal id.
      // (Best-effort: relies on the broker preserving the order comment.)
      bool fullyClosed = (StringLen(sigId) == 0) ? true : !PositionExistsForSignal(sigId);
      // ticket is unique per closed order, so it doubles as the idempotency dealId.
      ReportClosedTrade(sym, pnl, sigId, ticket, ticket, fullyClosed);
      RemoveOpenTicketAt(i);
   }
}

void ReportClosedTrade(string symbol, double pnl, string sigId, int ticket, int dealId, bool fullyClosed)
{
   string body = "{";
   body += "\"event\":\"close\",";
   body += "\"ticket\":"     + IntegerToString(ticket) + ",";
   body += "\"dealId\":"     + IntegerToString(dealId) + ",";    // unique -> idempotent
   body += "\"signalId\":\"" + sigId + "\",";
   body += "\"symbol\":\""   + symbol + "\",";
   body += "\"profit\":"     + DoubleToString(pnl, 2) + ",";        // REALIZED P&L
   body += "\"closed\":"     + (fullyClosed ? "true" : "false") + ",";
   body += "\"openTrades\":" + IntegerToString(CountOpenTrades()) + ",";
   body += "\"balance\":"    + DoubleToString(AccountBalance(), 2) + ",";
   body += "\"equity\":"     + DoubleToString(AccountEquity(), 2) + ",";
   body += "\"profitAcct\":" + DoubleToString(AccountProfit(), 2); // account floating P&L
   body += "}";
   string resp = "";
   int code = HttpPostJson(API_URL + "/api/trades", body, resp);
   if (code != 200) {
      code = HttpPostJson(API_URL + "/api/trades", body, resp);
      if (code != 200) { QueueUnreported(body); Print("[NEXUS] ⚠ close report queued"); }
   }
}

void SendHeartbeat()
{
   double dl = dayStartEquity - AccountEquity();
   double dlp = (dayStartEquity > 0) ? (dl / dayStartEquity * 100.0) : 0;
   string body = "{";
   body += "\"balance\":"     + DoubleToString(AccountBalance(),2) + ",";
   body += "\"equity\":"      + DoubleToString(AccountEquity(),2) + ",";
   body += "\"profit\":"      + DoubleToString(AccountProfit(),2) + ",";
   body += "\"openTrades\":"  + IntegerToString(CountOpenTrades()) + ",";
   body += "\"dailyLossPct\":"+ DoubleToString(dlp,2) + ",";
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
   int c = 0;
   for (int i = OrdersTotal() - 1; i >= 0; i--)
      if (OrderSelect(i, SELECT_BY_POS, MODE_TRADES) && OrderMagicNumber() == MagicNumber &&
          (OrderType() == OP_BUY || OrderType() == OP_SELL)) c++;
   return c;
}

int CountOpenTradesBySymbol(string symbol)
{
   int c = 0;
   for (int i = OrdersTotal() - 1; i >= 0; i--)
      if (OrderSelect(i, SELECT_BY_POS, MODE_TRADES) && OrderMagicNumber() == MagicNumber &&
          (OrderType() == OP_BUY || OrderType() == OP_SELL) && OrderSymbol() == symbol) c++;
   return c;
}

bool PositionExistsForSignal(string sigId)
{
   string needle = "NEXUS|" + sigId;
   for (int i = OrdersTotal() - 1; i >= 0; i--)
      if (OrderSelect(i, SELECT_BY_POS, MODE_TRADES) && OrderMagicNumber() == MagicNumber &&
          StringFind(OrderComment(), needle) >= 0) return true;
   return false;
}

string ParseSigId(string comment)
{
   // "NEXUS|<sigId>|C.." → <sigId>
   int p = StringFind(comment, "NEXUS|");
   if (p < 0) return "";
   int s = p + 6;
   int e = StringFind(comment, "|", s);
   if (e < 0) e = StringLen(comment);
   return StringSubstr(comment, s, e - s);
}

bool IsSignalExecuted(string sigId)
{
   for (int i = 0; i < executedCount; i++) if (executedSignals[i] == sigId) return true;
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

bool IsPartialed(string sigId)
{
   if (StringLen(sigId) == 0) return false;
   for (int i = 0; i < partialedCount; i++) if (partialedSigs[i] == sigId) return true;
   return false;
}
void MarkPartialed(string sigId)
{
   if (StringLen(sigId) == 0 || IsPartialed(sigId)) return;
   partialedCount++;
   ArrayResize(partialedSigs, partialedCount);
   partialedSigs[partialedCount - 1] = sigId;
}

//+------------------------------------------------------------------+
//| EXECUTED-ID PERSISTENCE                                            |
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
      StringTrimLeft(line); StringTrimRight(line);
      if (StringLen(line) > 0 && !IsSignalExecuted(line)) {
         executedCount++;
         ArrayResize(executedSignals, executedCount);
         executedSignals[executedCount - 1] = line;
      }
   }
   FileClose(h);
   Print("[NEXUS] Loaded ", executedCount, " executed signal ids");
}

//+------------------------------------------------------------------+
//| SYMBOL MAPPING + VALIDATION                                        |
//+------------------------------------------------------------------+
bool IsSymbolAllowed(string symbol)
{
   string parts[];
   int n = StringSplit(AllowedSymbols, ',', parts);
   for (int i = 0; i < n; i++) { StringTrimLeft(parts[i]); StringTrimRight(parts[i]); if (parts[i] == symbol) return true; }
   return false;
}

string MapSymbol(string dashSymbol)
{
   string pairs[];
   int n = StringSplit(SymbolMap, ',', pairs);
   for (int i = 0; i < n; i++) {
      string kv[];
      if (StringSplit(pairs[i], '=', kv) == 2) {
         StringTrimLeft(kv[0]); StringTrimRight(kv[0]); StringTrimLeft(kv[1]); StringTrimRight(kv[1]);
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
      if (MarketInfo(broker, MODE_BID) <= 0)
         Print("[NEXUS] ⚠ CONFIG: '", parts[i], "' → '", broker, "' NOT tradable on this broker. Fix SymbolMap.");
      else
         Print("[NEXUS] ✓ ", parts[i], " → ", broker);
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
      int ch = StringGetCharacter(json, valStart);
      if (ch != ' ' && ch != ':') break;
      valStart++;
   }
   bool quoted = (valStart < upTo && StringGetCharacter(json, valStart) == '"');
   if (quoted) valStart++;
   int valEnd = valStart;
   while (valEnd < upTo) {
      int ch = StringGetCharacter(json, valEnd);
      if (quoted && ch == '"') break;
      if (!quoted && (ch == ',' || ch == '}' || ch == ']' || ch == ' ' || ch == 10 || ch == 13)) break;
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
