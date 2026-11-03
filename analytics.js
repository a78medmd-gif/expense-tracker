/* PnL analytics core (STEP 1): TradeRecord adapter + AnalyticsEngine + ConditionsAnalyzer + SmartCoachEngine.
   Pure logic only: no DOM access, no image handling. All identifiers are English; user-facing text is Arabic. */
(function (root) {
  'use strict';

  /* ---------------- Constants & labels ---------------- */
  const MIN_CELL_SAMPLE = 5;        // minimum trades in a group before we draw conclusions from it
  const COACH_MIN_TRADES = 30;      // sample-size gate for the Smart Coach
  const WIN_RATE_GAP = 15;          // percentage points gap needed to call a "strong vs weak" condition

  const SESSION_LABELS = {
    Asian: 'الجلسة الآسيوية',
    London: 'جلسة لندن',
    Overlap: 'التداخل (لندن / نيويورك)',
    NewYork: 'جلسة نيويورك',
    OffHours: 'خارج الجلسات'
  };
  const SESSION_OPTIONS = ['Asian', 'London', 'Overlap', 'NewYork', 'OffHours'];
  const TIMEFRAME_OPTIONS = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];
  const DAY_LABELS = {
    Sunday: 'الأحد', Monday: 'الإثنين', Tuesday: 'الثلاثاء', Wednesday: 'الأربعاء',
    Thursday: 'الخميس', Friday: 'الجمعة', Saturday: 'السبت'
  };
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  /* ---------------- Small helpers ---------------- */
  const sum = a => a.reduce((x, y) => x + y, 0);
  const mean = a => (a.length ? sum(a) / a.length : 0);
  const pct = (n, d) => (d ? (n / d) * 100 : 0);
  const r1 = x => Math.round(x * 10) / 10;
  const r2 = x => Math.round(x * 100) / 100;
  // Arabic count agreement: 3-10 take the plural, others the singular form.
  const tw = n => n + (n >= 3 && n <= 10 ? ' صفقات' : ' صفقة');
  const mw = n => n + (n >= 3 && n <= 10 ? ' مرات' : ' مرة');

  // Standard normal CDF (Abramowitz-Stegun erf approximation).
  function normCdf(z) {
    const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
    return 0.5 * (1 + (z >= 0 ? y : -y));
  }
  const twoSidedP = z => 2 * (1 - normCdf(Math.abs(z)));

  // Wilson 95% interval for a proportion (returns percentages).
  function wilson(wins, n) {
    if (!n) return { low: 0, high: 0 };
    const z = 1.96, p = wins / n, z2 = z * z;
    const c = (p + z2 / (2 * n)) / (1 + z2 / n);
    const h = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
    return { low: Math.max(0, (c - h) * 100), high: Math.min(100, (c + h) * 100) };
  }

  /* ---------------- Session logic (Egypt local time) ---------------- */
  // The app stores the time the user typed (already Egypt local time, so DST is handled by the user's clock).
  // 01:00-10:00 Asian | 10:00-15:00 London | 15:00-17:00 Overlap | 17:00-23:00 NewYork | else OffHours
  function sessionFromTime(timeStr) {
    const m = /^(\d{1,2}):(\d{2})/.exec(timeStr || '');
    if (!m) return '';
    const h = +m[1] + (+m[2]) / 60;
    if (h >= 1 && h < 10) return 'Asian';
    if (h >= 10 && h < 15) return 'London';
    if (h >= 15 && h < 17) return 'Overlap';
    if (h >= 17 && h < 23) return 'NewYork';
    return 'OffHours';
  }
  function dayOfWeekFromDate(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr || '');
    if (!m) return '';
    return DAY_NAMES[new Date(+m[1], +m[2] - 1, +m[3], 12).getDay()];
  }

  /* ---------------- TradeRecord adapter ---------------- */
  // Maps the stored (short-key) trade object to a clean English record used by every engine.
  // Legacy trades without the new fields are derived on the fly, so old data keeps working.
  function toRecord(t) {
    const status = t.st || (t.a > 0 ? 'Win' : t.a < 0 ? 'Loss' : 'Open');
    const rawMistake = t.mistake_tag || t.ld || t.mt || '';
    // 'None' = followed the plan. Legacy wins without a tag are treated as plan-compliant;
    // legacy losses without a tag are 'Unknown' (excluded from adherence comparisons).
    const mistakeTag = rawMistake || (status === 'Win' ? 'None' : status === 'Loss' ? 'Unknown' : 'Unknown');
    return {
      id: t.id,
      account: t.ac || 'Personal',
      instrument: t.instrument || t.s || '',
      timeframe: t.timeframe || '',
      entryDate: t.d || '',
      entryTime: t.tm || '',
      exitDate: t.xd || t.d || '',
      dayOfWeek: t.day_of_week || dayOfWeekFromDate(t.d),
      session: t.session || sessionFromTime(t.tm),
      strategy: t.sg || '',
      setupQuality: t.sq || '',
      riskReward: t.rr || '',
      emotion: t.em || '',
      mistakeTag: mistakeTag,
      status: status,
      pnl: +t.a || 0,
      raw: t
    };
  }
  const closedOnly = recs => recs.filter(r => r.status !== 'Open');
  const chronological = recs => recs.slice().sort((a, b) =>
    (a.exitDate + (a.entryTime || '')).localeCompare(b.exitDate + (b.entryTime || '')) || a.id - b.id);

  /* ---------------- AnalyticsEngine (Module 1) ---------------- */
  const AnalyticsEngine = {
    // Predicates reused by the clickable dashboard cards (STEP 2).
    filters: {
      all: () => true,
      wins: r => r.pnl > 0,
      losses: r => r.pnl < 0,
      adherent: r => r.mistakeTag === 'None',
      violations: r => r.mistakeTag !== 'None' && r.mistakeTag !== 'Unknown'
    },

    select(records, filterKey) {
      return closedOnly(records).filter(this.filters[filterKey] || this.filters.all);
    },

    equityCurve(records) {
      let eq = 0;
      return chronological(closedOnly(records)).map(r => {
        eq += r.pnl;
        return { id: r.id, date: r.exitDate, pnl: r.pnl, equity: r2(eq) };
      });
    },

    maxDrawdown(records) {
      let peak = 0, eq = 0, maxDd = 0;
      chronological(closedOnly(records)).forEach(r => {
        eq += r.pnl;
        if (eq > peak) peak = eq;
        const dd = peak - eq;
        if (dd > maxDd) maxDd = dd;
      });
      return { amount: r2(maxDd) }; // peak-to-trough drop in cumulative P/L ($)
    },

    // The trades between the equity peak and the trough of the maximum drawdown (for the clickable card).
    drawdownTrades(records) {
      const arr = chronological(closedOnly(records));
      let eq = 0, peak = 0, peakIdx = -1, maxDd = 0, s = -1, e = -1;
      arr.forEach((r, i) => {
        eq += r.pnl;
        if (eq > peak) { peak = eq; peakIdx = i; }
        const dd = peak - eq;
        if (dd > maxDd) { maxDd = dd; s = peakIdx + 1; e = i; }
      });
      return maxDd ? arr.slice(s, e + 1) : [];
    },

    summarize(records) {
      const c = closedOnly(records);
      const wins = c.filter(r => r.pnl > 0), losses = c.filter(r => r.pnl < 0);
      const grossWin = sum(wins.map(r => r.pnl));
      const grossLoss = Math.abs(sum(losses.map(r => r.pnl)));
      const avgWin = mean(wins.map(r => r.pnl));
      const avgLoss = mean(losses.map(r => r.pnl)); // negative number
      const winRate = pct(wins.length, c.length);
      const classified = c.filter(r => r.mistakeTag !== 'Unknown');
      const adherent = classified.filter(AnalyticsEngine.filters.adherent);
      return {
        totalTrades: c.length,
        wins: wins.length,
        losses: losses.length,
        breakeven: c.length - wins.length - losses.length,
        winRate: r1(winRate),
        netPnl: r2(sum(c.map(r => r.pnl))),
        grossProfit: r2(grossWin),
        grossLoss: r2(grossLoss),
        avgWin: r2(avgWin),
        avgLoss: r2(avgLoss),
        profitFactor: grossLoss ? r2(grossWin / grossLoss) : (grossWin ? null : 0), // null = infinite (no losses)
        expectancy: r2(mean(c.map(r => r.pnl))), // average P/L per trade = winRate*avgWin + lossRate*avgLoss
        maxDrawdown: AnalyticsEngine.maxDrawdown(c),
        planAdherence: r1(pct(adherent.length, classified.length)),
        adherentCount: adherent.length,
        classifiedCount: classified.length
      };
    }
  };

  /* ---------------- ConditionsAnalyzer (Module 2) ---------------- */
  const ConditionsAnalyzer = {
    // dimension: 'session' | 'instrument' | 'timeframe' | 'dayOfWeek' | 'strategy'
    groupStats(records, dimension) {
      const groups = {};
      closedOnly(records).forEach(r => {
        const k = r[dimension];
        if (!k) return;
        (groups[k] = groups[k] || []).push(r);
      });
      return Object.keys(groups).map(k => {
        const g = groups[k], w = g.filter(r => r.pnl > 0), l = g.filter(r => r.pnl < 0);
        const gl = Math.abs(sum(l.map(r => r.pnl)));
        return {
          key: k, n: g.length, wins: w.length,
          winRate: r1(pct(w.length, g.length)),
          netPnl: r2(sum(g.map(r => r.pnl))),
          avgPnl: r2(mean(g.map(r => r.pnl))),
          profitFactor: gl ? r2(sum(w.map(r => r.pnl)) / gl) : null
        };
      }).sort((a, b) => b.avgPnl - a.avgPnl);
    },

    // Strategy x (session | instrument | timeframe) matrix.
    crossStats(records, rowDim, colDim) {
      const out = {};
      closedOnly(records).forEach(r => {
        const a = r[rowDim], b = r[colDim];
        if (!a || !b) return;
        ((out[a] = out[a] || {})[b] = out[a][b] || []).push(r);
      });
      const res = {};
      Object.keys(out).forEach(a => {
        res[a] = Object.keys(out[a]).map(b => {
          const g = out[a][b], w = g.filter(r => r.pnl > 0);
          return { key: b, n: g.length, winRate: r1(pct(w.length, g.length)), netPnl: r2(sum(g.map(r => r.pnl))), avgPnl: r2(mean(g.map(r => r.pnl))) };
        });
      });
      return res;
    },

    // Data-driven summary: strongest condition, weakest condition, costliest behavior (mistake tag or emotion).
    highlights(records, opts) {
      const L = Object.assign({
        strategy: v => v, instrument: v => v, session: v => SESSION_LABELS[v] || v, timeframe: v => v,
        dayOfWeek: v => DAY_LABELS[v] || v, mistake: v => v, emotion: v => v
      }, (opts && opts.labels) || {});
      const titles = { session: 'الجلسة', instrument: 'الزوج', timeframe: 'الفريم', dayOfWeek: 'اليوم', strategy: 'الاستراتيجية' };
      const c = closedOnly(records), cand = [];
      Object.keys(titles).forEach(dim => ConditionsAnalyzer.groupStats(c, dim).forEach(g => {
        if (g.n >= MIN_CELL_SAMPLE) cand.push(Object.assign({ dim: dim }, g));
      }));
      const fmt = g => titles[g.dim] + ' «' + L[g.dim](g.key) + '»: ' + tw(g.n) + '، نسبة فوز ' + g.winRate + '%، متوسط ' + fmtMoney(g.avgPnl) + ' للصفقة (صافي ' + fmtMoney(g.netPnl) + ').';
      cand.sort((x, y) => y.avgPnl * Math.sqrt(y.n) - x.avgPnl * Math.sqrt(x.n)); // favors larger samples over lucky small ones
      const best = cand.length && cand[0].avgPnl > 0 ? cand[0] : null;
      const worstC = cand.length ? cand[cand.length - 1] : null;
      const worst = worstC && worstC !== best ? worstC : null;
      // costliest behavior
      const beh = [];
      const byKey = (arr, pick, kind) => {
        const m = {};
        arr.forEach(r => { const k = pick(r); if (k) (m[k] = m[k] || []).push(r); });
        Object.keys(m).forEach(k => { const g = m[k]; if (g.length >= 2) beh.push({ kind: kind, key: k, n: g.length, netPnl: r2(sum(g.map(r => r.pnl))) }); });
      };
      byKey(c, r => (r.mistakeTag !== 'None' && r.mistakeTag !== 'Unknown') ? r.mistakeTag : '', 'mistake');
      byKey(c, r => r.emotion, 'emotion');
      beh.sort((x, y) => x.netPnl - y.netPnl);
      const cost = beh.length && beh[0].netPnl < 0 ? beh[0] : null;
      return {
        sampleSize: c.length,
        strongest: best && { dim: best.dim, key: best.key, text: fmt(best) },
        weakest: worst && { dim: worst.dim, key: worst.key, profitable: worst.avgPnl >= 0, text: fmt(worst) },
        costliest: cost && Object.assign({}, cost, { text: (cost.kind === 'mistake' ? 'الخطأ «' : 'الدخول في حالة «') + L[cost.kind](cost.key) + '» تكرر ' + mw(cost.n) + ' وكلّفك ' + fmtMoney(cost.netPnl) + ' إجمالًا.' }),
        caveat: c.length < COACH_MIN_TRADES ? 'العينة ' + tw(c.length) + ' فقط؛ اعتبر الأرقام مؤشرًا مبدئيًا.' : ''
      };
    },

    /* opts.labels = { strategy(v), instrument(v), session(v), timeframe(v), dayOfWeek(v) } optional label resolvers */
    discover(records, opts) {
      const L = Object.assign({
        strategy: v => v,
        instrument: v => v,
        session: v => SESSION_LABELS[v] || v,
        timeframe: v => v,
        dayOfWeek: v => DAY_LABELS[v] || v
      }, (opts && opts.labels) || {});
      const dimTitle = { session: 'الجلسة', instrument: 'الزوج', timeframe: 'الفريم', dayOfWeek: 'اليوم' };
      const findings = [];

      // 1) Best / worst condition inside each single dimension.
      ['session', 'instrument', 'timeframe', 'dayOfWeek'].forEach(dim => {
        const g = ConditionsAnalyzer.groupStats(records, dim).filter(x => x.n >= MIN_CELL_SAMPLE);
        if (g.length < 2) return;
        const best = g[0], worst = g[g.length - 1];
        if (best.avgPnl <= worst.avgPnl) return;
        findings.push({
          type: 'single', dimension: dim, best: best, worst: worst,
          text: 'أعلى أداء حسب ' + dimTitle[dim] + ': ' + L[dim](best.key) + ' (نسبة فوز ' + best.winRate + '%، متوسط ' +
            fmtMoney(best.avgPnl) + ' للصفقة)، وأضعف أداء: ' + L[dim](worst.key) + ' (نسبة فوز ' + worst.winRate +
            '%، متوسط ' + fmtMoney(worst.avgPnl) + ' للصفقة).'
        });
      });

      // 2) Strategy x session, strategy x instrument, strategy x timeframe.
      [['session', 'في', 'الجلسات'], ['instrument', 'على', 'الأزواج'], ['timeframe', 'على فريم', 'الفريمات']].forEach(cfg => {
        const colDim = cfg[0], prep = cfg[1];
        const cross = ConditionsAnalyzer.crossStats(records, 'strategy', colDim);
        Object.keys(cross).forEach(strat => {
          const cells = cross[strat].filter(x => x.n >= MIN_CELL_SAMPLE).sort((a, b) => b.avgPnl - a.avgPnl);
          if (cells.length < 2) return;
          const best = cells[0], worst = cells[cells.length - 1];
          const gap = best.winRate - worst.winRate;
          const signFlip = best.avgPnl > 0 && worst.avgPnl < 0;
          if (best.avgPnl <= 0 || (gap < WIN_RATE_GAP && !signFlip)) return; // only call a condition 'efficient' if it is actually profitable
          findings.push({
            type: 'cross', strategy: strat, dimension: colDim, best: best, worst: worst,
            text: 'استراتيجية ' + L.strategy(strat) + ' تعمل بكفاءة ' + prep + ' ' + L[colDim](best.key) + ' (نسبة فوز ' +
              best.winRate + '% من ' + tw(best.n) + ') لكنها تضعف ' + prep + ' ' + L[colDim](worst.key) + ' (نسبة فوز ' +
              worst.winRate + '% من ' + tw(worst.n) + ').'
          });
        });
      });

      return {
        findings: findings,
        enoughData: findings.length > 0,
        emptyMessage: findings.length ? '' : 'لا توجد بيانات كافية بعد لاكتشاف ارتباطات موثوقة. يلزم ' + MIN_CELL_SAMPLE + ' صفقات على الأقل في كل حالة للمقارنة.'
      };
    }
  };

  function fmtMoney(x) { return (x < 0 ? '-' : '') + '$' + Math.abs(x).toFixed(2); }

  /* ---------------- SmartCoachEngine (Module 3) ---------------- */
  const SmartCoachEngine = {
    INSUFFICIENT_MESSAGE: 'حجم العينة غير كافٍ لاستخراج استنتاجات إحصائية دقيقة. يرجى الاستمرار في تدوين صفقاتك للوصول إلى 30 صفقة على الأقل.',

    _setStats(set) {
      const w = set.filter(r => r.pnl > 0);
      const pnls = set.map(r => r.pnl);
      const m = mean(pnls);
      const variance = pnls.length > 1 ? sum(pnls.map(x => (x - m) * (x - m))) / (pnls.length - 1) : 0;
      const ci = wilson(w.length, set.length);
      return {
        n: set.length, wins: w.length,
        winRate: r1(pct(w.length, set.length)),
        winRateCI: { low: r1(ci.low), high: r1(ci.high) },
        netPnl: r2(sum(pnls)), avgPnl: r2(m), variance: variance
      };
    },

    // Two-proportion z-test on win rates.
    _winRateP(a, b) {
      if (!a.n || !b.n) return 1;
      const p = (a.wins + b.wins) / (a.n + b.n);
      const se = Math.sqrt(p * (1 - p) * (1 / a.n + 1 / b.n));
      return se ? twoSidedP((a.wins / a.n - b.wins / b.n) / se) : 1;
    },
    // Welch test (normal approximation) on mean P/L per trade.
    _pnlP(a, b) {
      if (a.n < 2 || b.n < 2) return 1;
      const se = Math.sqrt(a.variance / a.n + b.variance / b.n);
      return se ? twoSidedP((a.avgPnl - b.avgPnl) / se) : 1;
    },
    _uncertainty(a, b, p) {
      const small = Math.min(a.n, b.n);
      if (small < MIN_CELL_SAMPLE) return { level: 'High', label: 'مرتفع جدًا' };
      if (p < 0.05 && small >= 10) return { level: 'Low', label: 'منخفض' };
      if (p < 0.2) return { level: 'Medium', label: 'متوسط' };
      return { level: 'High', label: 'مرتفع' };
    },

    analyze(records) {
      const c = closedOnly(records);
      if (c.length < COACH_MIN_TRADES) {
        return { status: 'insufficient', totalTrades: c.length, required: COACH_MIN_TRADES, message: SmartCoachEngine.INSUFFICIENT_MESSAGE };
      }
      const A = c.filter(r => r.mistakeTag === 'None');                                   // Set A: followed the plan
      const B = c.filter(r => r.mistakeTag !== 'None' && r.mistakeTag !== 'Unknown');      // Set B: any mistake tag
      const unclassified = c.length - A.length - B.length;
      if (!A.length || !B.length) {
        return {
          status: 'one_sided', totalTrades: c.length, setA: A.length, setB: B.length,
          message: 'لا يمكن إجراء المقارنة لأن إحدى المجموعتين فارغة (صفقات بدون أخطاء: ' + A.length + '، صفقات بها أخطاء: ' + B.length +
            '). حدّد «تحليل الأخطاء» في صفقاتك لتفعيل التحليل السلوكي.'
        };
      }
      const sa = SmartCoachEngine._setStats(A), sb = SmartCoachEngine._setStats(B);
      const pWin = SmartCoachEngine._winRateP(sa, sb), pPnl = SmartCoachEngine._pnlP(sa, sb);
      const unc = SmartCoachEngine._uncertainty(sa, sb, Math.min(pWin, pPnl));
      const winGap = r1(sa.winRate - sb.winRate), avgGap = r2(sa.avgPnl - sb.avgPnl);

      const paragraphs = [];
      paragraphs.push('الصفقات الملتزمة بالخطة (المجموعة A): ' + tw(sa.n) + '، نسبة الفوز ' + sa.winRate + '%، صافي ' + fmtMoney(sa.netPnl) +
        '، متوسط ' + fmtMoney(sa.avgPnl) + ' للصفقة. الصفقات التي شابها خطأ (المجموعة B): ' + tw(sb.n) + '، نسبة الفوز ' + sb.winRate +
        '%، صافي ' + fmtMoney(sb.netPnl) + '، متوسط ' + fmtMoney(sb.avgPnl) + ' للصفقة.');
      const dir = winGap > 0 ? 'أعلى' : winGap < 0 ? 'أقل' : 'مساوية';
      paragraphs.push('الفارق في نسبة الفوز: ' + Math.abs(winGap) + ' نقطة مئوية (المجموعة A ' + dir + ' من B)، والفارق في متوسط الربح للصفقة: ' +
        fmtMoney(avgGap) + '. القيمة الاحتمالية لفارق نسبة الفوز ≈ ' + r2(pWin) + '، ولفارق متوسط الربح ≈ ' + r2(pPnl) + '.');
      paragraphs.push('مستوى عدم اليقين: ' + unc.label + '. ' + (unc.level === 'Low'
        ? 'الفارق يبدو متسقًا إحصائيًا مع حجم العينة الحالي، مع بقاء احتمال التأثر بتغيّر ظروف السوق.'
        : 'حجم العينة وتباين النتائج لا يسمحان بالجزم بأن الفارق حقيقي وليس صدفة؛ تعامل معه كمؤشر أولي فقط.') +
        ' نطاق الثقة 95% لنسبة الفوز: A [' + sa.winRateCI.low + '% – ' + sa.winRateCI.high + '%]، B [' + sb.winRateCI.low + '% – ' + sb.winRateCI.high + '%].');
      if (unclassified > 0) paragraphs.push('ملاحظة: ' + tw(unclassified) + ' بدون تصنيف أخطاء لم تُدرج في المقارنة.');

      return {
        status: 'ok', totalTrades: c.length, setA: sa, setB: sb,
        winRateGap: winGap, avgPnlGap: avgGap, pWinRate: r2(pWin), pAvgPnl: r2(pPnl),
        uncertainty: unc, unclassified: unclassified,
        paragraphs: paragraphs,
        questions: SmartCoachEngine._questions(B, sa, sb)
      };
    },

    // Reflective, behavior-focused questions. Never trade advice.
    _questions(setB, sa, sb) {
      const q = [];
      const losingB = setB.filter(r => r.pnl < 0);
      if (losingB.length) q.push('ما الذي يدفعك لكسر قواعدك في هذه الصفقات الخاسرة؟');
      const top = arr => {
        const m = {};
        arr.forEach(x => { if (x) m[x] = (m[x] || 0) + 1; });
        const e = Object.entries(m).sort((a, b) => b[1] - a[1]);
        return e.length ? { key: e[0][0], count: e[0][1] } : null;
      };
      const tag = top(setB.map(r => r.mistakeTag));
      if (tag && tag.count >= 2) q.push('الخطأ الأكثر تكرارًا في سجلك تكرر ' + mw(tag.count) + '. ما الموقف أو الشعور الذي يسبق حدوثه عادةً؟');
      const emo = top(setB.map(r => r.emotion));
      if (emo && emo.count >= 2) q.push('تتكرر حالة نفسية بعينها في الصفقات التي شابها خطأ (' + mw(emo.count) + '). كيف كانت حالتك قبل الدخول، وماذا كنت تحتاج في تلك اللحظة؟');
      if (sb.winRate > sa.winRate) q.push('نسبة فوزك في الصفقات المخالفة للخطة ليست أقل من الملتزمة بها. هل تعتقد أن العينة الحالية تعكس الواقع، أم أن النتائج القصيرة تخدعك؟');
      q.push('لو راجعت آخر صفقة خالفت فيها خطتك، ما اللحظة التي اتخذت فيها القرار فعليًا؟');
      return q;
    }
  };

  /* ---------------- Export ---------------- */
  root.PnLAnalytics = {
    toRecord, sessionFromTime, dayOfWeekFromDate,
    AnalyticsEngine, ConditionsAnalyzer, SmartCoachEngine,
    SESSION_LABELS, SESSION_OPTIONS, TIMEFRAME_OPTIONS, DAY_LABELS,
    MIN_CELL_SAMPLE, COACH_MIN_TRADES
  };
  if (typeof module !== 'undefined') module.exports = root.PnLAnalytics;
})(typeof window !== 'undefined' ? window : globalThis);
