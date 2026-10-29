/* ===== ZoneAssign v1.0 — 주소/단지명 → 담당 구역(Z1~Z5) → 차량 → 담당 컨설턴트 =====
 * 에스원 북서울지사 구역별 담당차량 조회 규칙(v6.4)을 DB(ta_zones / ta_zone_rules)에서 읽어 판정합니다.
 * 다른 앱에서도 이 파일을 그대로 가져가 쓰면 됩니다.
 *
 *   await ZoneAssign.load(db);                               // db = supabase client (1회, 이후 캐시)
 *   const r = ZoneAssign.resolve({ address, name });         // name(고객/단지명)은 선택
 *   r.consultant  → '임영민' (타지사/판정불가는 null)   r.vehicle → '127호'   r.zone → 'Z1'
 *   r.level       → high | mid | low | ambiguous | other | none
 *   r.basis       → 판정 근거 문장      r.cands → 후보 [{zone, vehicle, consultant, label}]
 */
(function (root) {
  'use strict';
  var LS_KEY = 'zoneAssign.v1';
  var ZA = { ready: false, error: '', R: null, Z: {}, X: null };

  /* ---------- 문자열 정리 ---------- */
  function norm(s) {
    s = String(s == null ? '' : s).replace(/[ㆍᆞ・∙•·]/g, '·');
    try { s = s.normalize('NFKC'); } catch (e) {}
    s = s.replace(/(^|[^\d])4\s*[.·]?\s*19\s*로/g, '$14·19로');
    return s.replace(/\s+/g, ' ').trim();
  }
  function compact(s) { return String(s || '').replace(/[\s()\[\],]/g, ''); }

  /* ---------- 규칙 색인 ---------- */
  function setData(rules, zones) {
    var R = rules || {}, X = {};
    ZA.R = R; ZA.Z = zones || {};
    // 행정동 → 구역 (상계3·4동 → 상계3동, 상계4동 별칭 포함) / 행정동 → 자치구
    X.dm = {}; X.dist = {};
    var di = R.dong_index || {};
    Object.keys(di).forEach(function (k) {
      var sp = k.indexOf(' '), d = k.slice(0, sp), n = k.slice(sp + 1), z = di[k];
      X.dm[n] = z; X.dist[n] = d;
      var m = /^(.*?)(\d+)·(\d+)동$/.exec(n);
      if (m) { [m[1] + m[2] + '동', m[1] + m[3] + '동'].forEach(function (a) { X.dm[a] = z; X.dist[a] = d; }); }
    });
    // 큰길 번호 구간
    X.ranges = {};
    ((R.main_road_ranges && R.main_road_ranges.rows) || []).forEach(function (r) {
      (X.ranges[r[0]] = X.ranges[r[0]] || []).push({ from: r[1], to: r[2], dong: r[3], side: r[4] || '', pri: r[5] ? 1 : 0 });
    });
    // ○○로N길 기준점
    X.anchors = {};
    ((R.gil_anchors && R.gil_anchors.rows) || []).forEach(function (r) {
      (X.anchors[r[0]] = X.anchors[r[0]] || []).push({ no: r[1], dong: r[2] });
    });
    // 단지·기관명(landmark) 색인: compact 이름 → {구역:1}
    var lm = {};
    function add(n, z) { n = compact(n); if (n.length < 2) return; (lm[n] = lm[n] || {})[z] = 1; }
    Object.keys(R.zones || {}).forEach(function (z) { ((R.zones[z] || {}).landmarks || []).forEach(function (n) { add(n, z); }); });
    X.lm = lm;
    // 이름 일부 키워드(태릉·공릉·상계 등) — 가장 마지막 보조 수단
    X.kw = {};
    (R.keywords || []).forEach(function (kv) { var n = compact(kv[0]); if (n.length >= 2) X.kw[n] = kv[1]; });
    X.kwNames = Object.keys(X.kw).sort(function (a, b) { return b.length - a.length; });
    X.gov = {};
    (R.government_offices || []).forEach(function (g) { X.gov[compact(g[0])] = g[1]; });
    X.names = Object.keys(lm).concat(Object.keys(X.gov).filter(function (n) { return !lm[n]; }));
    X.names.sort(function (a, b) { return b.length - a.length; });
    X.oor = (R.out_of_area_roads || []);
    X.oorr = (R.out_of_area_regions || []);
    X.known = {};
    Object.keys(X.ranges).concat(R.inner_roads || [], X.oor, Object.keys(X.anchors)).forEach(function (n) { X.known[n] = 1; });
    ZA.X = X; ZA.ready = true;
  }

  /* ---------- 결과 객체 ---------- */
  function out(zone, level, basis, cands) {
    var z = (zone && ZA.Z[zone]) || {};
    return {
      zone: zone || null, zoneName: z.name || '', vehicle: z.vehicle || (zone === 'OTHER' ? '타지사' : ''),
      consultant: (zone && zone !== 'OTHER' && z.consultant) ? z.consultant : null,
      level: level, basis: basis || '',
      cands: (cands || []).map(function (c) { var cz = ZA.Z[c.zone] || {}; return { zone: c.zone, vehicle: cz.vehicle || (c.zone === 'OTHER' ? '타지사' : ''), consultant: (c.zone !== 'OTHER' && cz.consultant) || null, label: c.label || '' }; })
    };
  }

  /* ---------- 분할동 판정 ---------- */
  function splitResolve(D, ctx) {
    var R = ZA.R, rule = (R.split_rules || {})[D];
    if (!rule) return { cands: [] };
    var road = ctx && ctx.road, num = ctx && ctx.num, i, r;
    if (road) {
      var nr = R.main_road_number_rules && R.main_road_number_rules[D] && R.main_road_number_rules[D][road];
      if (nr && num != null) { for (i = 0; i < nr.length; i++) if (num >= nr[i][0] && num <= nr[i][1]) return { zone: nr[i][2], how: D + ' ' + road + ' ' + num + '번' }; }
      var pr = R.parity_rules && R.parity_rules[D] && R.parity_rules[D][road];
      if (pr && num != null) return { zone: (num % 2 === 1 ? pr.o : pr.e), how: D + ' ' + road + ' ' + (num % 2 === 1 ? '홀수' : '짝수') + '번' };
      for (i = 0; i < (rule.roads || []).length; i++) { r = rule.roads[i]; if (r[0] === road) return { zone: r[1], how: D + ' ' + road }; }
      for (i = 0; i < (rule.prefix || []).length; i++) { r = rule.prefix[i]; if (road.indexOf(r[0]) === 0) return { zone: r[1], how: D + ' ' + road }; }
      var op = rule.opts && rule.opts[road];
      if (op) return { cands: op.map(function (o) { return { zone: o[0], label: o[1] }; }) };
    }
    return { cands: (rule.fallback || []).map(function (f) { return { zone: f[0], label: f[1] }; }) };
  }

  /* ---------- 행정동 → 결과 ---------- */
  function dongResult(D, ctx, lvl, how) {
    var z = ZA.X.dm[D];
    if (!z) return null;
    if (z === 'SPLIT') {
      var s = splitResolve(D, ctx);
      if (s.zone) return out(s.zone, lvl === 'high' ? 'mid' : lvl, '분할동 ' + (s.how || D));
      return out(null, 'ambiguous', D + ' 은(는) 경계가 갈리는 동입니다 (도로·번지로 확인 필요)', s.cands);
    }
    return out(z, lvl, how || ('행정동 ' + D));
  }

  /* ---------- 주소 요소 추출 ---------- */
  function parseRoad(t) {
    var re = /(4·19로|[가-힣]+로(?:\d+[가-힣]?길)?|[가-힣]+길)\s*(\d+)(?:-(\d+))?/g, m, first = null, pick = null;
    while ((m = re.exec(t))) {
      var road = m[1].replace(/^(?:도봉|노원|강북|성북|중랑|동대문)구/, '');
      var g = /^(.*로)(\d+)[가-힣]?길$/.exec(road);
      var o = { road: road, parent: g ? g[1] : road, gil: !!g, gilNo: g ? parseInt(g[2], 10) : null, num: parseInt(m[2], 10) };
      if (!first) first = o;
      if (!pick && ZA.X.known[o.parent]) pick = o;
    }
    return pick || first;
  }
  function lookupSuffix(tok, map, minLen) {
    for (var i = 0; i <= tok.length - minLen; i++) { var sub = tok.slice(i); if (Object.prototype.hasOwnProperty.call(map, sub)) return sub; }
    return null;
  }
  function findDong(t) {
    var re = /[가-힣]+\d*(?:·\d+)?동|[가-힣]+본동/g, m;
    while ((m = re.exec(t))) { var k = lookupSuffix(m[0], ZA.X.dm, 3); if (k) return k; }
    return null;
  }
  function findLegal(t) {
    var re = /[가-힣]+동/g, m, L = ZA.R.legal_dong_index || {};
    while ((m = re.exec(t))) { var k = lookupSuffix(m[0], L, 2); if (k) return { name: k, v: L[k] }; }
    return null;
  }

  /* ---------- 큰길 번호 / 길 기준점 → 행정동 ---------- */
  function locateRoad(ro, ok) {
    var X = ZA.X, best = null;
    if (!ro.gil && ro.num != null) {
      (X.ranges[ro.parent] || []).forEach(function (r) {
        if (ro.num < r.from || ro.num > r.to) return;
        if (r.side && ((ro.num % 2 === 1) !== (r.side === 'o'))) return;
        if (!X.dm[r.dong] || !ok(r.dong)) return;
        var w = r.to - r.from;
        if (!best || r.pri > best.pri || (r.pri === best.pri && w < best.w)) best = { dong: r.dong, w: w, pri: r.pri };
      });
      if (best) return { dong: best.dong, how: ro.road + ' ' + ro.num + '번 구간 → ' + best.dong, lvl: 'mid' };
    }
    if (ro.gil) {
      var anc = (X.anchors[ro.parent] || []).filter(function (a) { return X.dm[a.dong] && ok(a.dong); }), n = null, i;
      for (i = 0; i < anc.length; i++) { if (anc[i].no === ro.gilNo) return { dong: anc[i].dong, how: ro.road + ' 기준점 → ' + anc[i].dong, lvl: 'mid' }; }
      for (i = 0; i < anc.length; i++) { var dd = Math.abs(anc[i].no - ro.gilNo); if (dd <= 15 && (!n || dd < n.d)) n = { d: dd, dong: anc[i].dong }; }
      if (n) return { dong: n.dong, how: ro.road + ' 가까운 기준점 추정 → ' + n.dong, lvl: 'low' };
    }
    return null;
  }

  /* ---------- 후보 동 목록(법정동이 여러 행정동에 걸칠 때) ---------- */
  function candResolve(cand, ctx, why) {
    var X = ZA.X, exact = [], i, s;
    if (ctx && ctx.road) {
      cand.forEach(function (D) {
        if (X.dm[D] === 'SPLIT') { s = splitResolve(D, ctx); if (s.zone) exact.push({ zone: s.zone, how: s.how }); }
      });
      var zs = {}; exact.forEach(function (e) { zs[e.zone] = e; });
      var ks = Object.keys(zs);
      if (ks.length === 1) return out(ks[0], 'mid', '분할동 ' + zs[ks[0]].how);
    }
    var all = [], seen = {};
    cand.forEach(function (D) {
      var z = X.dm[D]; if (!z) return;
      if (z === 'SPLIT') { splitResolve(D, ctx).cands.forEach(function (c) { var k = c.zone + c.label; if (!seen[k]) { seen[k] = 1; all.push({ zone: c.zone, label: D + ' ' + c.label }); } }); }
      else { var k2 = z + D; if (!seen[k2]) { seen[k2] = 1; all.push({ zone: z, label: D }); } }
    });
    var zset = {}; all.forEach(function (c) { zset[c.zone] = 1; });
    var zk = Object.keys(zset);
    if (zk.length === 1) return out(zk[0], 'mid', why + ' (해당 동 모두 같은 구역)');
    if (!zk.length) return null;
    return out(null, 'ambiguous', why + ' — 번지·도로 번호가 없어 구역이 갈립니다', all);
  }

  /* ---------- 번동 지번 표본 ---------- */
  function jibunResolve(t) {
    var S = (ZA.R.jibun_samples || {})['번동'];
    var m = /번동\s*(산)?\s*(\d+)(?:-(\d+))?/.exec(t);
    if (!S || !m) return null;
    var san = m[1] ? 1 : 0, main = parseInt(m[2], 10), sub = m[3] ? parseInt(m[3], 10) : 0, best = null;
    S.forEach(function (s) {
      var d = Math.abs(s[1] - main) * 1000 + (s[1] === main ? Math.abs(s[2] - sub) : 0) + (s[0] !== san ? 100000 : 0);
      if (!best || d < best.d) best = { d: d, s: s };
    });
    if (!best) return null;
    var exact = best.s[1] === main && best.s[2] === sub && best.s[0] === san;
    var r = dongResult(best.s[3], { road: best.s[4] || '', num: null }, exact ? 'mid' : 'low', '번동 ' + main + (sub ? '-' + sub : '') + (exact ? ' 지번 표본' : ' 가까운 지번 표본(' + best.s[1] + ') 기준 추정') + ' → ' + best.s[3]);
    if (r && r.zone && !exact) r.level = 'low';
    return r;
  }

  /* ---------- 주소 구조 판정 ---------- */
  function structured(t) {
    var X = ZA.X;
    t = t.replace(/[()\[\]]/g, ' ').replace(/\s+/g, ' ');
    var distM = /(도봉구|노원구|강북구|성북구|중랑구|동대문구)/.exec(t), dist = distM ? distM[1] : null;
    var ro = parseRoad(t), D = findDong(t), legal = findLegal(t);
    // 1) 행정동 표기
    if (D) return dongResult(D, ro, 'high', '행정동 ' + D);
    // 2) 관할 밖 지역
    var inArea = dist && dist !== '동대문구';
    if (!inArea && !(legal && /이문/.test(legal.name))) {
      var hit = X.oorr.filter(function (r) { return t.indexOf(r) >= 0; })[0];
      if (hit) return out('OTHER', 'other', '관할 밖 지역 (' + hit + ')');
      if (ro && X.oor.indexOf(ro.parent) >= 0) return out('OTHER', 'other', '관할 밖 도로 (' + ro.parent + ')');
    }
    // 3) 도로명 + 번호
    var cand = legal && Array.isArray(legal.v) ? legal.v : null;
    var stem = legal && typeof legal.v === 'string' ? legal.name.replace(/동$/, '') : null;
    if (ro) {
      var ok = function (dn) {
        if (cand) return cand.indexOf(dn) >= 0;
        if (stem) return dn.indexOf(stem) === 0;
        return !dist || !X.dist[dn] || X.dist[dn] === dist;
      };
      var exactSplit = function () {
        var dongs = cand || Object.keys(ZA.R.split_rules || {}), ex = {};
        dongs.forEach(function (dn) { if (X.dm[dn] === 'SPLIT') { var s = splitResolve(dn, ro); if (s.zone) ex[s.zone] = s.how; } });
        var ek = Object.keys(ex);
        return ek.length === 1 ? out(ek[0], 'mid', '분할동 ' + ex[ek[0]]) : null;
      };
      var xr = null;
      if (ro.gil || !X.known[ro.parent]) { xr = exactSplit(); if (xr) return xr; }   // 골목길은 분할동 도로 목록을 먼저 확인
      var loc = locateRoad(ro, ok);
      if (loc) { var dr = dongResult(loc.dong, ro, loc.lvl, loc.how); if (dr) { if (!dr.basis || dr.basis.indexOf(loc.how) < 0) dr.basis = loc.how + (dr.basis ? ' / ' + dr.basis : ''); return dr; } }
    }
    // 4) 법정동
    if (legal) {
      if (typeof legal.v === 'string') return out(legal.v, 'mid', '법정동 ' + legal.name);
      if (legal.name === '번동') { var jr = jibunResolve(t); if (jr) return jr; }
      return candResolve(legal.v, ro, '법정동 ' + legal.name);
    }
    return null;
  }

  /* ---------- 단지·기관명 판정 ---------- */
  function landmarks(ct) {
    var X = ZA.X, used = new Array(ct.length), hits = [], i, j;
    X.names.forEach(function (n) {
      var idx = ct.indexOf(n);
      while (idx >= 0) {
        var free = true; for (j = idx; j < idx + n.length; j++) if (used[j]) { free = false; break; }
        var nx = ct.charAt(idx + n.length);
        if (free && (nx === '로' || nx === '길') && !/[로길]$/.test(n)) free = false;   // 도로명의 일부(마들로, 삼각산로 등)는 단지명으로 보지 않음
        if (free) { for (j = idx; j < idx + n.length; j++) used[j] = 1; hits.push(n); break; }
        idx = ct.indexOf(n, idx + 1);
      }
    });
    var zs = {}, gov = null;
    hits.forEach(function (n) { if (X.lm[n]) Object.keys(X.lm[n]).forEach(function (z) { zs[z] = 1; }); if (X.gov[n] && !gov) gov = { name: n, addr: X.gov[n] }; });
    return { hits: hits, zones: Object.keys(zs), gov: gov };
  }

  function kwHit(ct, k) {
    var idx = ct.indexOf(k);
    while (idx >= 0) { var nx = ct.charAt(idx + k.length); if (!((nx === '로' || nx === '길') && !/[로길]$/.test(k))) return true; idx = ct.indexOf(k, idx + 1); }
    return false;
  }

  /* ---------- 공개 resolve ---------- */
  function resolve(input) {
    if (!ZA.ready) return out(null, 'none', '구역 규칙이 아직 로드되지 않았습니다');
    var a = typeof input === 'string' ? { address: input } : (input || {});
    var addr = norm(a.address), all = norm([a.address, a.name, a.extra].filter(Boolean).join(' '));
    if (!all) return out(null, 'none', '주소가 없습니다');
    var lmr = landmarks(compact(all)), st = null;
    try { st = structured(addr || all); } catch (e) { st = null; }
    if (!st && addr && all !== addr) { try { st = structured(all); } catch (e2) { st = null; } }
    var named = lmr.hits.slice(0, 3).join(', ');
    if (lmr.gov) {
      var g = null; try { g = structured(norm(lmr.gov.addr)); } catch (e3) {}
      if (g && g.zone) { g.basis = '관공서·기관 ' + lmr.gov.name + ' 등록 주소 → ' + g.basis; g.level = g.level === 'low' ? 'low' : 'high'; return g; }
    }
    if (lmr.zones.length === 1) {
      var z = lmr.zones[0];
      if (st && st.zone && st.zone !== z) {
        var r = out(z, 'mid', '단지·기관명 \'' + named + '\' 기준 (주소로는 ' + (st.vehicle || st.zone) + ' — 확인 필요)', [{ zone: z, label: '단지·기관명 ' + named }, { zone: st.zone, label: '주소 판정' }]);
        return r;
      }
      return out(z, 'high', '단지·기관명 \'' + named + '\'');
    }
    if (st && (st.zone || st.cands.length)) return st;
    if (lmr.zones.length <= 1) {
      var kz = {}, kn = [];
      for (var q = 0; q < ZA.X.kwNames.length; q++) { var kk = ZA.X.kwNames[q]; if (kwHit(compact(all), kk)) { kz[ZA.X.kw[kk]] = 1; kn.push(kk); } }
      var kzk = Object.keys(kz);
      if (kzk.length === 1) return out(kzk[0], 'low', '이름 키워드 \'' + kn.slice(0, 3).join(', ') + '\' (추정)');
    }
    if (lmr.zones.length > 1) return out(null, 'ambiguous', '단지·기관명 \'' + named + '\' 이(가) 여러 구역에 걸칩니다', lmr.zones.map(function (zz) { return { zone: zz, label: '' }; }));
    return out(null, 'none', '주소에서 구역을 특정하지 못했습니다 (동·도로명·단지명 확인)');
  }

  /* ---------- DB 로드 ---------- */
  async function load(db, force) {
    if (ZA.ready && !force) return true;
    try {
      var rs = await Promise.all([db.from('ta_zones').select('*').order('sort_order', { ascending: true }), db.from('ta_zone_rules').select('key,data')]);
      if (rs[0].error) throw rs[0].error;
      if (rs[1].error) throw rs[1].error;
      if (!rs[0].data.length || !rs[1].data.length) throw new Error('구역 테이블이 비어 있습니다 (설정 SQL 실행 필요)');
      var rules = {}, zones = {};
      rs[1].data.forEach(function (r) { rules[r.key] = r.data; });
      rs[0].data.forEach(function (z) { if (z.active !== false) zones[z.zone] = z; });
      try { root.localStorage.setItem(LS_KEY, JSON.stringify({ rules: rules, zones: zones })); } catch (e) {}
      setData(rules, zones); ZA.error = ''; return true;
    } catch (e) {
      try {
        var c = JSON.parse(root.localStorage.getItem(LS_KEY) || 'null');
        if (c && c.rules) { setData(c.rules, c.zones); ZA.error = '저장된 사본 사용 중 (' + (e.message || e) + ')'; return true; }
      } catch (x) {}
      ZA.error = e && e.message ? e.message : String(e);
      return false;
    }
  }

  root.ZoneAssign = {
    load: load, resolve: resolve, setData: setData,
    get ready() { return ZA.ready; }, get error() { return ZA.error; },
    zones: function () { return ZA.Z; },
    consultantOf: function (zone) { var z = ZA.Z[zone]; return z && zone !== 'OTHER' ? (z.consultant || null) : null; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
