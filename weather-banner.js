/* ==========================================================================
   weather-banner.js — TA 관리 포털 날씨 배너
   - 현재 위치(GPS) 기준 현재 날씨 + 오늘 날씨(최고/최저, 시간대별 기온·강수확률)
   - 데이터: Open-Meteo (API 키 불필요) / 지역명: 지도 SDK(ta3Reverse) → BigDataCloud 순
   - 배너를 누르면 일기예보 사이트(네이버 날씨)가 새 탭으로 열려 해당 지역 상세 날씨 표시
   사용: <div id="taWxBox"></div> 를 두고 TAWeather.mount('taWxBox') 호출 (여러 번 호출해도 안전)
   ========================================================================== */
(function () {
  'use strict';
  if (window.TAWeather) return;

  var LS_KEY = 'S1_WX_V1';
  var TTL = 20 * 60 * 1000;                 // 20분 이내면 다시 받지 않음
  var STALE_MAX = 3 * 60 * 60 * 1000;       // 갱신 실패 시 3시간까지는 마지막 값 표시
  var DEFAULT_LOC = { lat: 37.6396, lng: 127.0257, name: '서울 강북구' };   // 위치 권한이 없을 때 기본 지역
  // 상세 일기예보 이동 주소 (지역명 + 날씨 검색). 다른 사이트로 바꾸려면 이 함수만 수정하세요.
  function forecastUrl(region) {
    return 'https://search.naver.com/search.naver?query=' + encodeURIComponent((region || DEFAULT_LOC.name) + ' 날씨');
  }

  var S = { box: null, data: null, loc: null, at: 0, busy: false, err: '', note: '', sig: '', timer: 0, bound: false };

  /* ---------------- 스타일 ---------------- */
  function injectCss() {
    if (document.getElementById('taWxCss')) return;
    var st = document.createElement('style'); st.id = 'taWxCss';
    st.textContent = [
      '.wx{position:relative;overflow:hidden;border-radius:20px;color:#fff;padding:14px 16px 12px;margin:0 0 14px;cursor:pointer;box-shadow:0 6px 20px rgba(16,24,40,.16);-webkit-tap-highlight-color:transparent;transition:transform .15s ease;text-shadow:0 1px 2px rgba(0,0,0,.12);outline:none;}',
      '.wx:active{transform:scale(.985);}',
      '.wx:focus-visible{box-shadow:0 0 0 3px rgba(47,107,255,.55),0 6px 20px rgba(16,24,40,.16);}',
      '.wx>*{position:relative;z-index:1;}',
      '.wx-glow{position:absolute !important;z-index:0 !important;right:-40px;top:-50px;width:190px;height:190px;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.34),rgba(255,255,255,0) 68%);pointer-events:none;}',
      '.wx-top{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12.5px;font-weight:700;}',
      '.wx-loc{display:flex;align-items:center;gap:4px;min-width:0;}',
      '.wx-loc svg{width:14px;height:14px;flex:none;stroke:#fff;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}',
      '.wx-loc span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.wx-upd{flex:none;opacity:.85;font-weight:600;font-size:11.5px;}',
      '.wx-main{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:4px;}',
      '.wx-l{display:flex;align-items:center;gap:8px;min-width:0;}',
      '.wx-ic{width:68px;height:68px;flex:none;overflow:visible;}',
      '.wx-t{font-size:48px;font-weight:800;line-height:1;letter-spacing:-2px;white-space:nowrap;}',
      '.wx-t sup{font-size:22px;font-weight:700;vertical-align:top;margin-left:1px;letter-spacing:0;position:relative;top:4px;}',
      '.wx-d{font-size:15.5px;font-weight:800;margin-top:4px;letter-spacing:-.3px;}',
      '.wx-s{font-size:12px;font-weight:600;opacity:.92;margin-top:1px;}',
      '.wx-r{text-align:right;flex:none;font-size:12px;font-weight:700;line-height:1.5;}',
      '.wx-r .k{opacity:.85;font-weight:600;}',
      '.wx-r b{font-size:21px;font-weight:800;letter-spacing:-.5px;}',
      '.wx-r .hi b{color:#ffd9d4;}.wx-r .lo b{color:#d3e9ff;}',
      '.wx-chart{margin-top:8px;position:relative;}',
      '.wx-chart svg{display:block;width:100%;height:60px;overflow:visible;}',
      '.wx-ax{position:relative;height:13px;font-size:10.5px;font-weight:600;opacity:.8;}',
      '.wx-ax span{position:absolute;top:1px;transform:translateX(-50%);white-space:nowrap;}',
      '.wx-ax span:first-child{transform:none;}.wx-ax span:last-child{transform:translateX(-100%);}',
      '.wx-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:6px;}',
      '.wx-chips{display:flex;gap:6px;flex-wrap:wrap;min-width:0;}',
      '.wx-chip{display:inline-flex;align-items:center;gap:4px;background:rgba(255,255,255,.2);border-radius:999px;padding:3px 9px;font-size:11.5px;font-weight:700;white-space:nowrap;}',
      '.wx-go{flex:none;font-size:11.5px;font-weight:800;opacity:.95;white-space:nowrap;}',
      '.wx-tip{margin-top:7px;font-size:12.5px;font-weight:800;letter-spacing:-.2px;}',
      '.wx-note{margin-top:5px;font-size:11px;font-weight:600;opacity:.82;}',
      '.wx-sk{background:linear-gradient(110deg,#c9d3e3 30%,#dfe6f1 45%,#c9d3e3 60%);background-size:300% 100%;animation:wxsh 1.5s ease infinite;color:#5b6a82;text-shadow:none;height:150px;display:flex;align-items:center;justify-content:center;font-size:13.5px;font-weight:800;}',
      '.wx-er{background:#f1f3f7;color:#4b5563;text-shadow:none;display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:13.5px;font-weight:700;box-shadow:0 1px 3px rgba(17,24,39,.06);border:1px solid #e8ebf1;}',
      '.wx-er button{background:#0f2547;color:#fff;border:0;border-radius:999px;padding:7px 14px;font-size:12.5px;font-weight:800;font-family:inherit;flex:none;}',
      /* 날씨 배경 입자 */
      '.wx-p{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0;}',
      '.wx-p i{position:absolute;top:-16px;display:block;}',
      '.wx-p.rain i{width:1.6px;height:14px;background:linear-gradient(rgba(255,255,255,0),rgba(255,255,255,.65));animation:wxfall .9s linear infinite;}',
      '.wx-p.snow i{width:5px;height:5px;border-radius:50%;background:rgba(255,255,255,.85);animation:wxsnow 5s linear infinite;}',
      '@keyframes wxfall{to{transform:translate3d(-14px,190px,0);}}',
      '@keyframes wxsnow{0%{transform:translate3d(0,0,0);}50%{transform:translate3d(12px,95px,0);}100%{transform:translate3d(-6px,190px,0);}}',
      '@keyframes wxsh{0%{background-position:100% 50%;}100%{background-position:0 50%;}}',
      /* 아이콘 애니메이션 */
      '.wx-ic .spin{transform-origin:32px 32px;animation:wxspin 22s linear infinite;}',
      '.wx-ic .drift{animation:wxdrift 6s ease-in-out infinite alternate;}',
      '.wx-ic .drop{animation:wxdrop 1.1s linear infinite;}',
      '.wx-ic .flake{animation:wxflake 2.6s linear infinite;}',
      '.wx-ic .bolt{animation:wxbolt 2.4s steps(1) infinite;}',
      '.wx-ic .pulse{animation:wxpulse 3.2s ease-in-out infinite;transform-origin:32px 32px;}',
      '@keyframes wxspin{to{transform:rotate(360deg);}}',
      '@keyframes wxdrift{from{transform:translateX(-2px);}to{transform:translateX(3px);}}',
      '@keyframes wxdrop{0%{transform:translateY(-3px);opacity:0;}25%{opacity:1;}100%{transform:translateY(10px);opacity:0;}}',
      '@keyframes wxflake{0%{transform:translate(0,-3px);opacity:0;}20%{opacity:1;}100%{transform:translate(2px,10px);opacity:0;}}',
      '@keyframes wxbolt{0%,60%,100%{opacity:1;}70%,80%{opacity:.25;}}',
      '@keyframes wxpulse{0%,100%{transform:scale(1);}50%{transform:scale(1.07);}}',
      /* 간단형(컴팩트) 배너 */
      '.wx{display:flex;align-items:center;gap:10px;padding:8px 14px;margin:0 0 10px;border-radius:16px;box-shadow:0 3px 12px rgba(16,24,40,.14);}',
      '.wx-ic{width:44px;height:44px;}',
      '.wx-c1{flex:1;min-width:0;}',
      '.wx-line{display:flex;align-items:baseline;gap:8px;white-space:nowrap;}',
      '.wx-t{font-size:28px;letter-spacing:-1px;}.wx-t sup{font-size:14px;top:2px;}',
      '.wx-d{font-size:14px;font-weight:800;margin:0;}.wx-s{font-size:12px;margin:0;}',
      '.wx-loc{font-size:12px;opacity:.95;}',
      '.wx-sk{height:60px;}',
      '@media (prefers-reduced-motion:reduce){.wx-ic *,.wx-p i,.wx-sk{animation:none !important;}}'
    ].join('\n');
    document.head.appendChild(st);
  }

  /* ---------------- 날씨 코드 → 한글/종류/배경 ---------------- */
  function info(code, isDay) {
    var c = Number(code);
    if (c === 0) return { t: '맑음', k: 'clear' };
    if (c === 1) return { t: '대체로 맑음', k: 'clear' };
    if (c === 2) return { t: '구름 조금', k: 'partly' };
    if (c === 3) return { t: '흐림', k: 'cloud' };
    if (c === 45 || c === 48) return { t: '안개', k: 'fog' };
    if (c >= 51 && c <= 55) return { t: '이슬비', k: 'drizzle' };
    if (c === 56 || c === 57) return { t: '어는 이슬비', k: 'drizzle' };
    if (c === 61) return { t: '약한 비', k: 'rain' };
    if (c === 63) return { t: '비', k: 'rain' };
    if (c === 65) return { t: '강한 비', k: 'rain' };
    if (c === 66 || c === 67) return { t: '어는 비', k: 'rain' };
    if (c === 71) return { t: '약한 눈', k: 'snow' };
    if (c === 73) return { t: '눈', k: 'snow' };
    if (c === 75) return { t: '강한 눈', k: 'snow' };
    if (c === 77) return { t: '싸락눈', k: 'snow' };
    if (c >= 80 && c <= 82) return { t: '소나기', k: 'rain' };
    if (c === 85 || c === 86) return { t: '눈 소나기', k: 'snow' };
    if (c === 95) return { t: '뇌우', k: 'thunder' };
    if (c === 96 || c === 99) return { t: '우박 동반 뇌우', k: 'thunder' };
    return { t: '날씨 정보', k: 'cloud' };
  }
  function bg(k, day) {
    if (!day) {
      if (k === 'clear' || k === 'partly') return 'linear-gradient(145deg,#0f2027,#203a43 55%,#2c5364)';
      if (k === 'rain' || k === 'drizzle' || k === 'thunder') return 'linear-gradient(145deg,#161d2e,#2b3650 60%,#3a4766)';
      return 'linear-gradient(145deg,#1d2433,#3a4560)';
    }
    switch (k) {
      case 'clear': return 'linear-gradient(145deg,#2c7be5,#5bbcf5)';
      case 'partly': return 'linear-gradient(145deg,#3f7fd6,#86bdf0)';
      case 'cloud': return 'linear-gradient(145deg,#5c6b83,#8d9bb2)';
      case 'fog': return 'linear-gradient(145deg,#6f7b8a,#a3adba)';
      case 'drizzle': return 'linear-gradient(145deg,#4a5d7a,#7b90ad)';
      case 'rain': return 'linear-gradient(145deg,#34445f,#5a6f90)';
      case 'snow': return 'linear-gradient(145deg,#6b83a8,#a9bdd8)';
      case 'thunder': return 'linear-gradient(145deg,#272b47,#4a4f7c)';
    }
    return 'linear-gradient(145deg,#4a86e8,#8ec5fc)';
  }

  /* ---------------- SVG 아이콘 ---------------- */
  var CLOUD = 'M18 47h30a9 9 0 0 0 .9-17.95A13 13 0 0 0 23.6 26 10.5 10.5 0 0 0 18 47z';
  function sunSvg(cx, cy, s) {
    var rays = '';
    for (var i = 0; i < 8; i++) rays += '<line x1="32" y1="9" x2="32" y2="15" transform="rotate(' + (i * 45) + ' 32 32)"/>';
    return '<g transform="translate(' + (cx - 32 * s) + ' ' + (cy - 32 * s) + ') scale(' + s + ')"><g class="spin" stroke="#FFD54A" stroke-width="3.2" stroke-linecap="round">' + rays + '</g><circle class="pulse" cx="32" cy="32" r="12" fill="#FFD54A"/><circle cx="32" cy="32" r="12" fill="url(#wxSunG)" opacity=".55"/></g>';
  }
  function moonSvg(cx, cy, s) {
    return '<g transform="translate(' + (cx - 32 * s) + ' ' + (cy - 32 * s) + ') scale(' + s + ')"><path class="pulse" d="M40 12a20 20 0 1 0 12 33 16 16 0 0 1-12-33z" fill="#FFE9A8"/></g>';
  }
  function cloudSvg(fill, dy) { return '<path class="drift" transform="translate(0 ' + (dy || 0) + ')" d="' + CLOUD + '" fill="' + fill + '"/>'; }
  function icon(k, day) {
    var body = '';
    var defs = '<defs><radialGradient id="wxSunG"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#FFD54A" stop-opacity="0"/></radialGradient></defs>';
    switch (k) {
      case 'clear': body = day ? sunSvg(32, 32, 1) : moonSvg(32, 32, 1); break;
      case 'partly': body = (day ? sunSvg(23, 21, .8) : moonSvg(23, 21, .8)) + cloudSvg('#fff', 4); break;
      case 'cloud': body = '<path class="drift" transform="translate(-6 -6) scale(.75)" d="' + CLOUD + '" fill="rgba(255,255,255,.7)"/>' + cloudSvg('#fff', 2); break;
      case 'fog': body = cloudSvg('#fff', -4) + '<g stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".9"><line x1="14" y1="50" x2="50" y2="50"/><line x1="20" y1="57" x2="56" y2="57"/></g>'; break;
      case 'drizzle': case 'rain':
        var n = k === 'rain' ? [[24, 0], [34, .35], [44, .7]] : [[28, 0], [40, .5]];
        body = cloudSvg('#e8edf7', -6) + '<g stroke="#9fd0ff" stroke-width="3" stroke-linecap="round">' + n.map(function (d) { return '<line class="drop" style="animation-delay:' + d[1] + 's" x1="' + d[0] + '" y1="48" x2="' + (d[0] - 2.5) + '" y2="55"/>'; }).join('') + '</g>'; break;
      case 'snow':
        body = cloudSvg('#eef2fa', -6) + '<g fill="#fff">' + [[24, 0], [34, .8], [44, 1.6]].map(function (d) { return '<circle class="flake" style="animation-delay:' + d[1] + 's" cx="' + d[0] + '" cy="52" r="2.6"/>'; }).join('') + '</g>'; break;
      case 'thunder':
        body = cloudSvg('#cfd6e6', -8) + '<path class="bolt" d="M34 38l-8 12h6l-3 10 12-15h-7l4-7z" fill="#FFD54A"/>'; break;
    }
    return '<svg class="wx-ic" viewBox="0 0 64 64" aria-hidden="true">' + defs + body + '</svg>';
  }
  function particles(k) {
    var cls = (k === 'rain' || k === 'thunder') ? 'rain' : (k === 'drizzle' ? 'rain' : (k === 'snow' ? 'snow' : ''));
    if (!cls) return '';
    var n = cls === 'snow' ? 16 : (k === 'drizzle' ? 12 : 22), h = '';
    for (var i = 0; i < n; i++) {
      var left = Math.round((i * 97) % 100), delay = ((i * 37) % 100) / 100 * (cls === 'snow' ? 5 : .9), dur = cls === 'snow' ? (4 + (i % 4)) : (.75 + (i % 3) * .15);
      h += '<i style="left:' + left + '%;animation-delay:-' + delay.toFixed(2) + 's;animation-duration:' + dur.toFixed(2) + 's"></i>';
    }
    return '<div class="wx-p ' + cls + '" aria-hidden="true">' + h + '</div>';
  }

  /* ---------------- 시간대별 기온 차트 ---------------- */
  function chart(hourly, nowH) {
    var T = hourly && hourly.temperature_2m, P = hourly && hourly.precipitation_probability;
    if (!T || T.length < 24) return '';
    var W = 300, H = 60, pt = 16, pb = 12, i;
    var vals = T.slice(0, 24).map(Number);
    if (vals.some(function (v) { return !isFinite(v); })) return '';
    var mx = Math.max.apply(null, vals), mn = Math.min.apply(null, vals), span = (mx - mn) || 1;
    var X = function (n) { return n / 23 * W; };
    var Y = function (v) { return pt + (mx - v) / span * (H - pt - pb); };
    var d = 'M' + X(0).toFixed(1) + ' ' + Y(vals[0]).toFixed(1);
    for (i = 0; i < 23; i++) {
      var x1 = X(i), y1 = Y(vals[i]), x2 = X(i + 1), y2 = Y(vals[i + 1]);
      d += ' Q' + x1.toFixed(1) + ' ' + y1.toFixed(1) + ' ' + ((x1 + x2) / 2).toFixed(1) + ' ' + ((y1 + y2) / 2).toFixed(1);
    }
    d += ' L' + X(23).toFixed(1) + ' ' + Y(vals[23]).toFixed(1);
    var area = d + ' L' + W + ' ' + H + ' L0 ' + H + ' Z';
    var bars = '';
    if (P && P.length >= 24) {
      for (i = 0; i < 24; i++) {
        var p = Math.max(0, Math.min(100, Number(P[i]) || 0)); if (p < 10) continue;
        var bh = p / 100 * 14;
        bars += '<rect x="' + (X(i) - 3.2).toFixed(1) + '" y="' + (H - bh).toFixed(1) + '" width="6.4" height="' + bh.toFixed(1) + '" rx="2" fill="rgba(160,215,255,.55)"/>';
      }
    }
    var iMax = vals.indexOf(mx), iMin = vals.indexOf(mn);
    var lab = function (idx, v, above) {
      var x = Math.max(12, Math.min(W - 12, X(idx)));
      return '<text x="' + x.toFixed(1) + '" y="' + (Y(v) + (above ? -6 : 13)).toFixed(1) + '" text-anchor="middle" font-size="10.5" font-weight="800" fill="#fff" stroke="none">' + Math.round(v) + '°</text>';
    };
    var nowX = X(Math.max(0, Math.min(23, nowH))), nowY = Y(vals[Math.max(0, Math.min(23, nowH))]);
    var labels = lab(iMax, mx, true) + (iMin !== iMax ? lab(iMin, mn, false) : '');
    var ax = [0, 6, 12, 18, 23].map(function (h) { return '<span style="left:' + (h / 23 * 100).toFixed(1) + '%">' + (h === 23 ? '24시' : h + '시') + '</span>'; }).join('');
    return '<div class="wx-chart"><svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="오늘 시간대별 기온">' +
      '<defs><linearGradient id="wxAr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".30"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>' +
      bars + '<path d="' + area + '" fill="url(#wxAr)" stroke="none"/><path d="' + d + '" fill="none" stroke="rgba(255,255,255,.92)" stroke-width="2.2" stroke-linecap="round" vector-effect="non-scaling-stroke"/>' +
      '<line x1="' + nowX.toFixed(1) + '" y1="' + (nowY + 5).toFixed(1) + '" x2="' + nowX.toFixed(1) + '" y2="' + H + '" stroke="rgba(255,255,255,.45)" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/>' +
      '<circle cx="' + nowX.toFixed(1) + '" cy="' + nowY.toFixed(1) + '" r="4.2" fill="#fff" stroke="rgba(255,255,255,.4)" stroke-width="5" paint-order="stroke"/>' +
      labels + '</svg><div class="wx-ax">' + ax + '</div></div>';
  }

  /* ---------------- 한 줄 팁 (예보 수치로만 판단) ---------------- */
  function tip(cur, day, k) {
    var rain = Number(day.rainMax) || 0, tmax = day.tmax, tmin = day.tmin, wind = Number(cur.wind) || 0;
    if (k === 'thunder') return '⚡ 천둥·번개 주의, 실외 이동은 잠시 미루세요';
    if (k === 'snow') return '❄ 눈 소식이 있어요. 운전 조심하세요';
    if (rain >= 60) return '☂ 오늘 비 올 확률 ' + rain + '% — 우산 챙기세요';
    if (rain >= 30) return '☂ 비 소식 가능성이 있어요 (' + rain + '%)';
    if (tmin <= 0) return '🧊 오늘 최저 ' + Math.round(tmin) + '° — 이른 아침 빙판 주의';
    if (tmax >= 33) return '🥵 오늘 최고 ' + Math.round(tmax) + '° — 폭염, 수분 보충하세요';
    if (wind >= 10) return '💨 바람이 강해요 (' + wind.toFixed(1) + 'm/s)';
    if (tmax - tmin >= 12) return '🧥 일교차가 커요 (' + Math.round(tmin) + '°~' + Math.round(tmax) + '°), 겉옷 챙기세요';
    return '';
  }

  /* ---------------- 렌더 ---------------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function hhmm(s) { var m = /T(\d\d:\d\d)/.exec(s || ''); return m ? m[1] : ''; }
  function norm(j) {
    if (!j || !j.current || !j.daily || !j.daily.time || !j.daily.time.length) return null;
    var c = j.current, d = j.daily;
    return {
      cur: { temp: c.temperature_2m, feel: c.apparent_temperature, hum: c.relative_humidity_2m, code: c.weather_code, wind: c.wind_speed_10m, day: c.is_day === 1, time: c.time },
      day: { tmax: d.temperature_2m_max[0], tmin: d.temperature_2m_min[0], rainMax: d.precipitation_probability_max ? d.precipitation_probability_max[0] : null, code: d.weather_code ? d.weather_code[0] : c.weather_code },
      hourly: j.hourly || null
    };
  }
  function render() {
    var box = S.box; if (!box) return;
    var html;
    if (!S.data) {
      html = S.err
        ? '<div class="wx wx-er" role="group"><span>🌤 날씨를 불러오지 못했어요</span><button type="button" data-wx="retry">다시 시도</button></div>'
        : '<div class="wx wx-sk">🌤 현재 위치의 날씨를 확인하고 있어요…</div>';
    } else {
      var D = S.data, cur = D.cur, day = D.day;
      var curI = info(cur.code, cur.day), dayI = info(day.code, true);
      var nowH = parseInt((/T(\d\d)/.exec(cur.time) || [0, 12])[1], 10) || 0;
      var loc = S.loc || DEFAULT_LOC, name = loc.name || '현재 위치';
      var t = tip(cur, day, curI.k);
      var chips = [];
      if (day.rainMax != null) chips.push('💧 강수확률 ' + Math.round(day.rainMax) + '%');
      if (cur.wind != null) chips.push('🍃 바람 ' + Number(cur.wind).toFixed(1) + 'm/s');
      if (cur.hum != null) chips.push('습도 ' + Math.round(cur.hum) + '%');
      var sameCond = dayI.t === curI.t ? '' : '오늘 하루 ' + dayI.t;
      var pin = '<svg viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';
      html = '<div class="wx" role="link" tabindex="0" data-wx="open" style="background:' + bg(curI.k, cur.day) + '" aria-label="' + esc(name + ' 현재 ' + Math.round(cur.temp) + '도 ' + curI.t + '. 눌러서 상세 일기예보 보기') + '">' +
        icon(curI.k, cur.day) +
        '<div class="wx-c1"><div class="wx-loc">' + pin + '<span>' + esc(name) + (S.loc && S.loc.fallback ? ' (기본)' : '') + '</span></div>' +
        '<div class="wx-line"><span class="wx-t">' + Math.round(cur.temp) + '<sup>°</sup></span><span class="wx-d">' + esc(curI.t) + '</span><span class="wx-s">체감 ' + Math.round(cur.feel) + '°</span></div></div>' +
        '<div class="wx-go">상세 ›</div></div>';
    }
    if (html === S.sig) return;          // 변화 없으면 다시 그리지 않음 (깜빡임 방지)
    S.sig = html; box.innerHTML = html;
  }

  /* ---------------- 위치 · 지역명 ---------------- */
  function dist(a, b) {
    var R = 6371, r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lng - a.lng) * r;
    var x = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function getPos() {
    return new Promise(function (res, rej) {
      if (!navigator.geolocation) return rej(new Error('nogeo'));
      var go = function () { navigator.geolocation.getCurrentPosition(function (p) { res({ lat: p.coords.latitude, lng: p.coords.longitude }); }, function (e) { rej(e); }, { enableHighAccuracy: false, timeout: 9000, maximumAge: 10 * 60 * 1000 }); };
      try {
        if (navigator.permissions && navigator.permissions.query) {
          navigator.permissions.query({ name: 'geolocation' }).then(function (r) { if (r.state === 'denied') rej(new Error('denied')); else go(); }, go);
        } else go();
      } catch (e) { go(); }
    });
  }
  function parseRegion(addr) {
    var t = String(addr || '').replace(/[(),]/g, ' ').split(/\s+/).filter(Boolean);
    if (!t.length) return '';
    var si = t[0].replace(/(특별자치시|특별자치도|특별시|광역시|도)$/, '') || t[0];
    var gus = [], dong = '';
    for (var i = 1; i < t.length; i++) {
      var w = t[i];
      if (/^\d/.test(w)) break;
      if (/[시군구]$/.test(w)) { gus.push(w); continue; }
      if (/[동읍면가]$/.test(w)) dong = w;
      break;
    }
    return [si].concat(gus, dong ? [dong] : []).join(' ');
  }
  function withTimeout(p, ms) { return Promise.race([p, new Promise(function (r) { setTimeout(function () { r(''); }, ms); })]); }
  function placeName(lat, lng) {
    var viaMap = (typeof window.ta3Reverse === 'function')
      ? withTimeout(Promise.resolve().then(function () { return window.ta3Reverse(lat, lng); }).catch(function () { return ''; }), 4500)
      : Promise.resolve('');
    return viaMap.then(function (addr) {
      var n = parseRegion(addr); if (n) return n;
      return withTimeout(fetch('https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=' + lat + '&longitude=' + lng + '&localityLanguage=ko')
        .then(function (r) { return r.json(); })
        .then(function (j) { return parseRegion([j.principalSubdivision, j.city, j.locality].filter(Boolean).join(' ')); })
        .catch(function () { return ''; }), 5000);
    });
  }

  /* ---------------- 데이터 ---------------- */
  function save() { try { localStorage.setItem(LS_KEY, JSON.stringify({ at: S.at, loc: S.loc, data: S.data })); } catch (e) {} }
  function load() {
    try { var o = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); if (o && o.data && o.loc && Date.now() - o.at < STALE_MAX) { S.data = o.data; S.loc = o.loc; S.at = o.at; } } catch (e) {}
  }
  function fetchWx(loc) {
    var u = 'https://api.open-meteo.com/v1/forecast?latitude=' + loc.lat.toFixed(4) + '&longitude=' + loc.lng.toFixed(4) +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day' +
      '&hourly=temperature_2m,precipitation_probability' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
      '&timezone=Asia%2FSeoul&forecast_days=1&wind_speed_unit=ms';
    var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    var to = setTimeout(function () { if (ctl) ctl.abort(); }, 12000);
    return fetch(u, ctl ? { signal: ctl.signal } : {}).then(function (r) { clearTimeout(to); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(function (j) {
      var n = norm(j); if (!n) throw new Error('bad data'); return n;
    });
  }
  function refresh(force) {
    if (S.busy) return;
    if (!force && S.data && Date.now() - S.at < TTL) return;
    S.busy = true; S.err = '';
    if (!S.data) render();
    var note = '';
    getPos().catch(function (e) {
      note = (e && (e.code === 1 || e.message === 'denied')) ? '위치 권한이 꺼져 있어 ' + ((S.loc && S.loc.name) || DEFAULT_LOC.name) + ' 기준으로 보여드려요' : '현재 위치를 확인하지 못해 ' + ((S.loc && S.loc.name) || DEFAULT_LOC.name) + ' 기준으로 보여드려요';
      return null;
    }).then(function (pos) {
      var prev = S.loc;
      var loc = pos ? { lat: pos.lat, lng: pos.lng, name: '', fallback: false } : (prev ? { lat: prev.lat, lng: prev.lng, name: prev.name, fallback: !!prev.fallback } : { lat: DEFAULT_LOC.lat, lng: DEFAULT_LOC.lng, name: DEFAULT_LOC.name, fallback: true });
      var needName = pos && (!prev || !prev.name || prev.fallback || dist(prev, pos) > 1);
      if (pos && !needName) loc.name = prev.name;
      return Promise.all([fetchWx(loc), needName ? placeName(loc.lat, loc.lng) : Promise.resolve(loc.name)]).then(function (r) {
        loc.name = r[1] || loc.name || '현재 위치';
        S.data = r[0]; S.loc = loc; S.at = Date.now(); S.note = note; S.err = ''; save();
      });
    }).catch(function (e) {
      if (window.console) console.warn('[TAWeather]', e);
      if (S.data) S.note = '최신 정보를 불러오지 못해 마지막 정보를 보여드려요'; else S.err = String((e && e.message) || e);
    }).then(function () { S.busy = false; render(); });
  }

  /* ---------------- 이벤트 · 공개 API ---------------- */
  function openForecast() {
    var region = (S.loc && S.loc.name) || DEFAULT_LOC.name;
    var w = window.open(forecastUrl(region), '_blank', 'noopener');
    if (!w) location.href = forecastUrl(region);
  }
  function bind(box) {
    if (box.__wxBound) return; box.__wxBound = true;
    box.addEventListener('click', function (ev) {
      var t = ev.target.closest && ev.target.closest('[data-wx]'); if (!t) return;
      if (t.getAttribute('data-wx') === 'retry') { ev.stopPropagation(); refresh(true); } else openForecast();
    });
    box.addEventListener('keydown', function (ev) {
      if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.getAttribute && ev.target.getAttribute('data-wx') === 'open') { ev.preventDefault(); openForecast(); }
    });
  }
  function mount(id) {
    var box = typeof id === 'string' ? document.getElementById(id) : id;
    if (!box) return;
    injectCss();
    if (S.box !== box) { S.box = box; S.sig = ''; bind(box); }
    if (!S.data && !S.at) load();
    render(); refresh(false);
    if (!S.bound) {
      S.bound = true;
      document.addEventListener('visibilitychange', function () { if (!document.hidden && S.box && document.body.contains(S.box)) refresh(false); });
      S.timer = setInterval(function () { if (!document.hidden && S.box && document.body.contains(S.box)) refresh(false); }, 10 * 60 * 1000);
    }
  }
  window.TAWeather = { mount: mount, refresh: function () { refresh(true); }, _parseRegion: parseRegion, _info: info };
})();
