/* ═══════════════════════════════════════════════════════
   TradingView Lightweight Charts Wrapper
   ─────────────────────────────────────────────────────
   Professional candlestick chart with volume, crosshair,
   and SMC overlay markers.
   ═══════════════════════════════════════════════════════ */

import { useEffect, useRef, memo } from 'react';
import { createChart, ColorType, CrosshairMode, CandlestickSeries, HistogramSeries, createSeriesMarkers } from 'lightweight-charts';
import { COLORS } from '../config/marketConfig.js';

const TVChart = memo(({ candles, smc, market, signals = [] }) => {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const volumeSeriesRef = useRef(null);
  const markersApiRef = useRef(null);
  const markersRef = useRef([]);
  const priceLinesRef = useRef([]);

  // ── Initialize chart ──
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#0f1117' },
        textColor: '#6b7084',
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(42,46,63,0.4)', style: 1 },
        horzLines: { color: 'rgba(42,46,63,0.4)', style: 1 },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: COLORS.crosshair,
          width: 1,
          style: 3,
          labelBackgroundColor: '#1e2235',
        },
        horzLine: {
          color: COLORS.crosshair,
          width: 1,
          style: 3,
          labelBackgroundColor: '#1e2235',
        },
      },
      rightPriceScale: {
        borderColor: '#2a2e3f',
        scaleMargins: { top: 0.1, bottom: 0.2 },
      },
      timeScale: {
        borderColor: '#2a2e3f',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 5,
      },
      handleScroll: { vertTouchDrag: false },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    });

    // Candlestick series (v5 API: addSeries with type)
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: COLORS.bull,
      downColor: COLORS.bear,
      borderUpColor: COLORS.bull,
      borderDownColor: COLORS.bear,
      wickUpColor: COLORS.bull,
      wickDownColor: COLORS.bear,
    });

    // Volume series (overlay at bottom, v5 API)
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });

    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    // Create the markers primitive ONCE; updates call setMarkers() so they don't
    // stack a fresh primitive on every render (the previous code leaked markers).
    markersApiRef.current = createSeriesMarkers(candleSeries, []);

    // Resize observer
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      chart.applyOptions({ width, height });
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      markersApiRef.current = null;
    };
  }, []);

  // ── Update candle data ──
  useEffect(() => {
    if (!candleSeriesRef.current || !candles?.length) return;

    // Deduplicate and sort by time (v5 requires strictly ascending unique times)
    const timeMap = new Map();
    candles.forEach(c => {
      if (c.time && !isNaN(c.time)) {
        timeMap.set(c.time, c); // last write wins for duplicates
      }
    });
    const sorted = [...timeMap.values()].sort((a, b) => a.time - b.time);
    if (sorted.length === 0) return;

    const candleData = sorted.map(c => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    const volumeData = sorted.map(c => ({
      time: c.time,
      value: c.volume || 0,
      color: c.close >= c.open ? COLORS.volume : COLORS.volumeBear,
    }));

    try {
      candleSeriesRef.current.setData(candleData);
      volumeSeriesRef.current.setData(volumeData);
    } catch (e) {
      console.warn('[TVChart] setData error:', e.message);
    }

    // ── SMC Markers (v5: createSeriesMarkers) ──
    if (smc && candleSeriesRef.current) {
      const markers = [];

      // Order block markers
      smc.obs?.slice(-8).forEach(ob => {
        const t = ob.time || candles[Math.min(ob.i, candles.length - 1)]?.time;
        if (!t) return;
        markers.push({
          time: t,
          position: ob.type === 'bull' ? 'belowBar' : 'aboveBar',
          color: ob.type === 'bull' ? COLORS.bull : COLORS.bear,
          shape: ob.type === 'bull' ? 'arrowUp' : 'arrowDown',
          text: `${ob.type === 'bull' ? '▲' : '▼'}OB`,
        });
      });

      // BOS / CHoCH markers
      smc.structs?.slice(-6).forEach(s => {
        const t = s.time || candles[Math.min(s.i, candles.length - 1)]?.time;
        if (!t) return;
        markers.push({
          time: t,
          position: s.dir === 'bull' ? 'aboveBar' : 'belowBar',
          color: s.type === 'BOS' ? COLORS.bos : COLORS.choch,
          shape: 'circle',
          text: s.type,
        });
      });

      // Liquidity Pools (EQH/EQL)
      smc.eqhs?.slice(-5).forEach(eqh => {
        if (!eqh.time) return;
        markers.push({ time: eqh.time, position: 'aboveBar', color: '#f59e0b', shape: 'circle', text: '$$$' });
      });
      smc.eqls?.slice(-5).forEach(eql => {
        if (!eql.time) return;
        markers.push({ time: eql.time, position: 'belowBar', color: '#f59e0b', shape: 'circle', text: '$$$' });
      });

      // Sort markers by time (required by lightweight-charts)
      markers.sort((a, b) => a.time - b.time);

      // Deduplicate
      const deduped = [];
      const seen = new Set();
      markers.forEach(m => {
        const key = `${m.time}-${m.position}-${m.text}`;
        if (!seen.has(key)) {
          seen.add(key);
          deduped.push(m);
        }
      });

      try {
        markersApiRef.current?.setMarkers(deduped);
      } catch (err) {
        console.warn('[TVChart] Markers error:', err);
      }
      markersRef.current = deduped;
    }
  }, [candles, smc]);

  // ── Draw Signal Lines & Zones ──
  useEffect(() => {
    if (!candleSeriesRef.current) return;
    
    // Clear old lines
    priceLinesRef.current.forEach(line => {
      try { candleSeriesRef.current.removePriceLine(line); } catch { /* line already gone */ }
    });
    priceLinesRef.current = [];

    // Draw Equilibrium
    if (smc?.zones?.equilibrium) {
      const eqLine = candleSeriesRef.current.createPriceLine({
        price: smc.zones.equilibrium,
        color: 'rgba(255, 255, 255, 0.2)',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'EQ',
      });
      priceLinesRef.current.push(eqLine);
    }

    // Draw Unmitigated FVGs
    if (smc?.fvgs) {
      smc.fvgs.forEach(fvg => {
        const fvgLine = candleSeriesRef.current.createPriceLine({
          price: fvg.top,
          color: fvg.type === 'bull' ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.4)',
          lineWidth: 1,
          lineStyle: 3,
          axisLabelVisible: false,
          title: 'FVG',
        });
        priceLinesRef.current.push(fvgLine);
      });
    }

    if (signals) {
      // Find signals for this market
      const mktName = market.replace('/', '');
      const activeSignals = signals.filter(s => (s.symbol === mktName || s.market === market) && s.status === 'ACTIVE');

      activeSignals.forEach(sig => {
        const entryLine = candleSeriesRef.current.createPriceLine({
          price: Number(sig.entry),
          color: '#818cf8',
          lineWidth: 2,
          lineStyle: 0, // Solid
          axisLabelVisible: true,
          title: 'ENTRY',
        });
        const slLine = candleSeriesRef.current.createPriceLine({
          price: Number(sig.sl),
          color: COLORS.bear,
          lineWidth: 1,
          lineStyle: 2, // Dashed
          axisLabelVisible: true,
          title: 'SL',
        });
        const tpLine = candleSeriesRef.current.createPriceLine({
          price: Number(sig.tp),
          color: COLORS.bull,
          lineWidth: 1,
          lineStyle: 2, // Dashed
          axisLabelVisible: true,
          title: 'TP',
        });

        priceLinesRef.current.push(entryLine, slLine, tpLine);
      });
    }
  }, [signals, market, smc]);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        minHeight: 0,
      }}
    />
  );
});

export default TVChart;
