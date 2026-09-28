/**
 * S1 북서울지사 영업일보 - Supabase Backend Adapter
 * Google Apps Script의 google.script.run 호출을 브라우저에서 가로채 Supabase 데이터베이스와 직접 통신합니다.
 */

(function(window) {
  'use strict';

  // --- Supabase 설정 ---
  const SUPABASE_URL = 'https://gpqlximhoqdybcewdfde.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_xUnGxyLCc5TB5nv4keVQVw__grqGJkP';

  let sb = null;
  function getSupabase() {
    if (!sb && window.supabase) {
      sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
    return sb;
  }

  // --- 유틸리티 ---
  function getTzToday() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function getSession_() {
    try {
      const raw = sessionStorage.getItem('s1_admin_session_v1') || sessionStorage.getItem('s1_session_v1');
      return raw ? JSON.parse(raw) : null;
    } catch(e) { return null; }
  }

  // --- 사용자 작업이력 로깅 엔진 (모든 추가/수정/삭제/인쇄/내보내기 자동 기록) ---
  function scopeNameKor_(scope) {
    if (scope === 'order' || scope === 'order_start') return '수주개시';
    if (scope === 'cancel') return '해약중지';
    if (scope === 'price' || scope === 'price_change') return '인상인하';
    if (scope === 'restart') return '재개시';
    if (scope === 'productdaily' || scope === 'product_daily') return '상품일보';
    if (scope === 'dashboard') return '대시보드';
    if (scope === 'gajungji') return '가중지';
    if (scope === 'filestore') return '파일저장소';
    if (scope === 'users') return '사용자관리';
    if (scope === 'targets') return '목표관리';
    return scope || '-';
  }

  window.logUserAction_ = async function(action, scope, targetId, details) {
    try {
      const client = getSupabase();
      if (!client) return;
      const sess = getSession_();
      const userName = (sess && sess.name) ? sess.name : '일반사용자';
      const userRole = (sess && sess.role) ? sess.role : '';
      const userPhone = (sess && sess.phone) ? sess.phone : '';
      const d = details || {};
      const korScope = scopeNameKor_(scope);

      const record = {
        consultant: userName,
        action: action,
        company: d.company || korScope,
        lead_id: d.contractNo || (targetId ? String(targetId) : '-'),
        changes: {
          scope: korScope,
          field: d.field || '',
          before: d.before !== undefined ? d.before : '',
          after: d.after !== undefined ? d.after : '',
          desc: d.desc || '',
          role: userRole,
          phone: userPhone
        },
        created_at: new Date().toISOString()
      };

      client.from('activity_logs').insert([record]).then(() => {});
    } catch(e) {
      console.warn('[ActivityLog] 기록 실패:', e);
    }
  };


  // --- 비즈니스 로직 구현체 (Code.gs 1:1 매핑) ---
    // --- 자연어 문장 분석 규칙 헬퍼 함수들 ---
  const AI_REPORT_HEADER_LINES_ = ['수주보고', '신규보고', '수주', '해약보고', '중지보고', '해약', '인상보고', '인하보고', '인상인하보고', '보고'];
  const AI_REPORT_PRODUCT_ALIAS_ = { '디지털': '정보보안' };
  const HOLIDAY_SET_ = new Set([
    '2026-01-01','2026-02-16','2026-02-17','2026-02-18','2026-03-01','2026-03-02',
    '2026-05-05','2026-05-08','2026-06-06','2026-08-15','2026-08-17',
    '2026-09-24','2026-09-25','2026-09-26','2026-09-27','2026-10-03','2026-10-05','2026-10-09','2026-12-25',
    '2027-01-01','2027-02-06','2027-02-07','2027-02-08','2027-02-09','2027-03-01',
    '2027-05-05','2027-05-13','2027-06-06','2027-08-15','2027-08-16',
    '2027-09-14','2027-09-15','2027-09-16','2027-10-03','2027-10-04','2027-10-09','2027-10-11','2027-12-25','2027-12-27'
  ]);

  function ruleParseToday_() { return getTzToday(); }
  function ruleParseAddDays_(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + days);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function ruleParseWeekStart_(baseDateStr) {
    const base = new Date(baseDateStr + 'T00:00:00');
    const offsetFromMonday = (base.getDay() + 6) % 7;
    return ruleParseAddDays_(baseDateStr, -offsetFromMonday);
  }
  function ruleParseWeekdayInWeek_(baseDateStr, weekdayKor, weekOffset) {
    const MON_BASED = { '월':0, '화':1, '수':2, '목':3, '금':4, '토':5, '일':6 };
    const weekStart = ruleParseWeekStart_(baseDateStr);
    return ruleParseAddDays_(weekStart, weekOffset * 7 + MON_BASED[weekdayKor]);
  }
  function ruleParseNearestFutureWeekday_(baseDateStr, weekday) {
    const base = new Date(baseDateStr + 'T00:00:00');
    let diff = (weekday - base.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    return ruleParseAddDays_(baseDateStr, diff);
  }
  function ruleParseFindDate_(text, today) {
    const SUN_BASED = { '일':0, '월':1, '화':2, '수':3, '목':4, '금':5, '토':6 };
    if (/오늘/.test(text)) return today;
    if (/어제/.test(text)) return ruleParseAddDays_(today, -1);
    if (/내일/.test(text)) return ruleParseAddDays_(today, 1);
    if (/모레/.test(text)) return ruleParseAddDays_(today, 2);
    let m = text.match(/(다음\s*주|담\s*주|차주)\s*([일월화수목금토])요일/);
    if (m) return ruleParseWeekdayInWeek_(today, m[2], 1);
    m = text.match(/(이번\s*주)\s*([일월화수목금토])요일/);
    if (m) return ruleParseWeekdayInWeek_(today, m[2], 0);
    m = text.match(/([일월화수목금토])요일/);
    if (m) return ruleParseNearestFutureWeekday_(today, SUN_BASED[m[1]]);
    m = text.match(/(\d{4})[-.\/](\d{1,2})[-.\/](\d{1,2})/);
    if (m) return m[1] + '-' + String(m[2]).padStart(2,'0') + '-' + String(m[3]).padStart(2,'0');
    m = text.match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
    if (m) return m[1] + '-' + String(m[2]).padStart(2,'0') + '-' + String(m[3]).padStart(2,'0');
    m = text.match(/(?<!\d)(\d{2})\s*년\s*(\d{1,2})[\/.](\d{1,2})/);
    if (m) { const yy = Number(m[1]); const yyyy = (yy <= 50 ? 2000 : 1900) + yy; return yyyy + '-' + String(m[2]).padStart(2,'0') + '-' + String(m[3]).padStart(2,'0'); }
    m = text.match(/(?<!\d)(\d{2})[-.\/](\d{1,2})[-.\/](\d{1,2})(?!\d)/);
    if (m) { const yy = Number(m[1]); const yyyy = (yy <= 50 ? 2000 : 1900) + yy; return yyyy + '-' + String(m[2]).padStart(2,'0') + '-' + String(m[3]).padStart(2,'0'); }
    m = text.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
    if (m) return today.slice(0,4) + '-' + String(m[1]).padStart(2,'0') + '-' + String(m[2]).padStart(2,'0');
    m = text.match(/(?<!\d)(\d{1,2})[\/.](\d{1,2})(?!\d)/);
    if (m) return today.slice(0,4) + '-' + String(m[1]).padStart(2,'0') + '-' + String(m[2]).padStart(2,'0');
    m = text.match(/(?<!\d)(\d{1,2})\s*일(?!\d)/);
    if (m) return today.slice(0,4) + '-' + today.slice(5,7) + '-' + String(m[1]).padStart(2,'0');
    return null;
  }
  function ruleParseAllDateMatches_(text, today) {
    const results = [];
    let m;
    const reAbs4 = /(\d{4})[-.\/](\d{1,2})[-.\/](\d{1,2})/g;
    while ((m = reAbs4.exec(text)) !== null) results.push({ idx: m.index, len: m[0].length, date: m[1] + '-' + String(m[2]).padStart(2,'0') + '-' + String(m[3]).padStart(2,'0') });
    const reYearKrFull = /(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/g;
    while ((m = reYearKrFull.exec(text)) !== null) results.push({ idx: m.index, len: m[0].length, date: m[1] + '-' + String(m[2]).padStart(2,'0') + '-' + String(m[3]).padStart(2,'0') });
    const reYearKr = /(?<!\d)(\d{2})\s*년\s*(\d{1,2})[\/.](\d{1,2})/g;
    while ((m = reYearKr.exec(text)) !== null) { const yy = Number(m[1]); const yyyy = (yy <= 50 ? 2000 : 1900) + yy; results.push({ idx: m.index, len: m[0].length, date: yyyy + '-' + String(m[2]).padStart(2,'0') + '-' + String(m[3]).padStart(2,'0') }); }
    const reAbs2 = /(?<!\d)(\d{2})[-.\/](\d{1,2})[-.\/](\d{1,2})(?!\d)/g;
    while ((m = reAbs2.exec(text)) !== null) {
      const overlap0 = results.some(function(r){ return m.index < r.idx + r.len && m.index + m[0].length > r.idx; });
      if (overlap0) continue;
      const yy = Number(m[1]); const yyyy = (yy <= 50 ? 2000 : 1900) + yy; results.push({ idx: m.index, len: m[0].length, date: yyyy + '-' + String(m[2]).padStart(2,'0') + '-' + String(m[3]).padStart(2,'0') });
    }
    const reMdKr = /(\d{1,2})\s*월\s*(\d{1,2})\s*일/g;
    while ((m = reMdKr.exec(text)) !== null) results.push({ idx: m.index, len: m[0].length, date: today.slice(0,4) + '-' + String(m[1]).padStart(2,'0') + '-' + String(m[2]).padStart(2,'0') });
    const reMd = /(?<!\d)(\d{1,2})[\/.](\d{1,2})(?!\d)/g;
    while ((m = reMd.exec(text)) !== null) {
      const overlap = results.some(function(r){ return m.index < r.idx + r.len && m.index + m[0].length > r.idx; });
      if (!overlap) results.push({ idx: m.index, len: m[0].length, date: today.slice(0,4) + '-' + String(m[1]).padStart(2,'0') + '-' + String(m[2]).padStart(2,'0') });
    }
    const reDayOnly = /(?<!\d)(\d{1,2})\s*일(?!\d)/g;
    while ((m = reDayOnly.exec(text)) !== null) {
      const overlap2 = results.some(function(r){ return m.index < r.idx + r.len && m.index + m[0].length > r.idx; });
      if (!overlap2) results.push({ idx: m.index, len: m[0].length, date: today.slice(0,4) + '-' + today.slice(5,7) + '-' + String(m[1]).padStart(2,'0') });
    }
    return results;
  }
  function ruleParseKeywordDate_(text, keywords, today, usedIdx) {
    for (let i = 0; i < keywords.length; i++) {
      const re = new RegExp(keywords[i] + '\\s*[:：]\\s*([^\\n]{1,14})');
      const m = re.exec(text);
      if (!m) continue;
      const d = ruleParseFindDate_(m[1], today);
      if (!d) continue;
      const valueStart = m.index + (m[0].length - m[1].length);
      if (usedIdx && usedIdx.indexOf(valueStart) !== -1) continue;
      if (usedIdx) usedIdx.push(valueStart);
      return d;
    }
    const dates = ruleParseAllDateMatches_(text, today).filter(function(d){ return !usedIdx || usedIdx.indexOf(d.idx) === -1; });
    if (!dates.length) return null;
    let best = null, bestDist = Infinity;
    keywords.forEach(function(kw){
      let from = 0, idx;
      while ((idx = text.indexOf(kw, from)) !== -1) {
        from = idx + 1;
        dates.forEach(function(d){
          const dist = (d.idx >= idx + kw.length) ? (d.idx - (idx + kw.length)) : (idx - (d.idx + d.len));
          const absDist = Math.abs(dist);
          if (absDist < bestDist) { bestDist = absDist; best = d; }
        });
      }
    });
    if (!best) return null;
    if (usedIdx) usedIdx.push(best.idx);
    return best.date;
  }
  function ruleParseKeywordDateInfo_(text, keywords, today, usedIdx) {
    for (let i = 0; i < keywords.length; i++) {
      const re = new RegExp(keywords[i] + '\\s*[:：]\\s*([^\\n]{1,14})');
      const m = re.exec(text);
      if (!m) continue;
      const d = ruleParseFindDate_(m[1], today);
      if (!d) continue;
      const valueStart = m.index + (m[0].length - m[1].length);
      if (usedIdx && usedIdx.indexOf(valueStart) !== -1) continue;
      if (usedIdx) usedIdx.push(valueStart);
      return { date: d, raw: m[1].trim() };
    }
    const dates = ruleParseAllDateMatches_(text, today).filter(function(d){ return !usedIdx || usedIdx.indexOf(d.idx) === -1; });
    if (!dates.length) return null;
    let best = null, bestDist = Infinity;
    keywords.forEach(function(kw){
      let from = 0, idx;
      while ((idx = text.indexOf(kw, from)) !== -1) {
        from = idx + 1;
        dates.forEach(function(d){
          const dist = (d.idx >= idx + kw.length) ? (d.idx - (idx + kw.length)) : (idx - (d.idx + d.len));
          const absDist = Math.abs(dist);
          if (absDist < bestDist) { bestDist = absDist; best = d; }
        });
      }
    });
    if (!best) return null;
    if (usedIdx) usedIdx.push(best.idx);
    return { date: best.date, raw: text.substr(best.idx, best.len) };
  }
  function ruleParseFindCar_(text) {
    const re = /0*([0-9]{1,3})\s*호/g;
    let m;
    const cars = [26, 27, 28, 127, 160];
    while ((m = re.exec(text)) !== null) {
      const n = Number(m[1]);
      if (cars.indexOf(n) !== -1) return String(n);
    }
    return '';
  }
  function ruleParseFindProduct_(text) {
    for (const key in AI_REPORT_PRODUCT_ALIAS_) { if (text.indexOf(key) !== -1) return AI_REPORT_PRODUCT_ALIAS_[key]; }
    return ruleParseFindFromList_(text, ['알람', '휴엔', '정보보안', '블루스캔', '유지보수']) || '알람';
  }
  function ruleParseGuessCompanyFromLines_(rawText, motiveList) {
    const lines = rawText.split(/\r?\n/).map(function(l){ return l.trim(); }).filter(function(l){ return l.length > 0; });
    if (lines.length < 2) return '';
    const cars = [26, 27, 28, 127, 160];
    const candidates = lines.filter(function(line){
      const lastTok_ = line.split(/\s+/).pop();
      if (AI_REPORT_HEADER_LINES_.indexOf(line) !== -1 || AI_REPORT_HEADER_LINES_.indexOf(lastTok_) !== -1) return false;
      if (/^[0-9][0-9,]*\s*(원|천원|만원|억원?)?$/.test(line)) return false;
      const carM = line.match(/^0*([0-9]{1,3})\s*호$/);
      if (carM && cars.indexOf(Number(carM[1])) !== -1) return false;
      if (motiveList.some(function(mv){ return mv && line.indexOf(mv) === 0; })) return false;
      if (/개시|기산|공사|반영|확정/.test(line) && /\d/.test(line)) return false;
      return true;
    });
    return candidates.join(' ');
  }
  function ruleParseCompanyNameByContractLine_(rawText) {
    const stripLabel = function(s){ return s.replace(/^상호명?\s*[:：]\s*/, '').trim(); };
    const lines = rawText.split(/\r?\n/).map(function(l){ return l.trim(); }).filter(function(l){ return l.length > 0; });
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/(?:^|[\s\t])(N\d{7,8})[\t ]+(.*)$/);
      if (!m) continue;
      if (m[2] && m[2].trim()) return stripLabel(m[2].trim());
      if (i + 1 < lines.length) return stripLabel(lines[i + 1]);
      return '';
    }
    return '';
  }
  function ruleParseFindAmount_(text) {
    let m = text.match(/([0-9][0-9,]*)\s*억\s*([0-9][0-9,]*)?\s*만?\s*원?/);
    if (m) { const eok = Number(m[1].replace(/,/g,'')); const man = m[2] ? Number(m[2].replace(/,/g,'')) : 0; return eok*100000000 + man*10000; }
    m = text.match(/([0-9][0-9,]*)\s*만\s*원?/);
    if (m) return Number(m[1].replace(/,/g,'')) * 10000;
    m = text.match(/([0-9][0-9,]*)\s*천\s*원?/);
    if (m) return Number(m[1].replace(/,/g,'')) * 1000;
    m = text.match(/([0-9][0-9,]{2,})\s*원/);
    if (m) return Number(m[1].replace(/,/g,''));
    return null;
  }
  function ruleParsePriceArrow_(text) {
    const m = text.match(/([0-9][0-9,]*\s*(?:억|만|천)?\s*원?)\s*(?:→|->|-->|=>|>)\s*([0-9][0-9,]*\s*(?:억|만|천)?\s*원?)/);
    if (!m) return null;
    const before = ruleParseFindAmount_(m[1]);
    const after = ruleParseFindAmount_(m[2]);
    if (before === null || after === null) return null;
    return { before: before, after: after, delta: after - before };
  }
  function ruleParseFindFromListLoose_(text, list) {
    const compact = text.replace(/\s+/g, '');
    for (let i = 0; i < list.length; i++) {
      if (list[i] && compact.indexOf(String(list[i]).replace(/\s+/g, '')) !== -1) return String(list[i]);
    }
    return '';
  }
  function ruleParseFindCompanyName_(text) {
    let m = text.match(/([가-힣A-Za-z0-9]{2,}(?:빌딩|타워|상가|센터|APT|아파트|빌라|사옥|플라자|의원|약국|마트|점|병원|매장|지점))/);
    if (m) return m[1];
    return '';
  }
  function ruleParseFindFromList_(text, list) {
    for (let i = 0; i < list.length; i++) { if (list[i] && text.indexOf(String(list[i])) !== -1) return String(list[i]); }
    return '';
  }
  function ruleParseFindFromListStandalone_(text, list) {
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (!v) continue;
      let from = 0, idx;
      while ((idx = text.indexOf(v, from)) !== -1) {
        from = idx + 1;
        const after = text.slice(idx + v.length, idx + v.length + 2);
        if (!/^(일|보고)/.test(after)) return v;
      }
    }
    return '';
  }
  function nextWorkingDay_(dateStr) {
    if (!dateStr) return dateStr;
    let d = dateStr;
    for (let i = 0; i < 14; i++) {
      const dow = new Date(d + 'T00:00:00').getDay();
      if (dow !== 0 && dow !== 6 && !HOLIDAY_SET_.has(d)) return d;
      d = ruleParseAddDays_(d, 1);
    }
    return d;
  }


  const Backend = {
    // ==========================================
    // TA 관리 표준 로그인 & 회원가입 (Backend 구현체)
    // ==========================================
    login: async function(phone, pw) {
      const client = getSupabase();
      if (!client) throw new Error('Supabase client not loaded');
      const cleanPhone = String(phone || '').replace(/[^0-9]/g, '');
      const cleanPw = String(pw || '').trim();

      if (!cleanPhone || !cleanPw) {
        return { success: false, error: '전화번호와 비밀번호를 모두 입력하세요.' };
      }

      // 지사장 마스터 비밀번호 긴급 프리패스
      const isMasterPw = (cleanPw === 'sy0928@@' || cleanPw === 'S1_nowon_master_2026');

      // 010 및 10 형태 유연 조회 (TA 관리 동일)
      const pNoZero = cleanPhone.startsWith('0') ? cleanPhone.slice(1) : cleanPhone;
      const pWithZero = cleanPhone.startsWith('0') ? cleanPhone : ('0' + cleanPhone);
      const searchPhones = Array.from(new Set([cleanPhone, pNoZero, pWithZero]));

      const { data: users, error } = await client.from('app_users').select('*').in('phone', searchPhones).limit(5);
      if (error) {
        return { success: false, error: 'DB 접근 오류: ' + (error.message || JSON.stringify(error)) };
      }

      if ((!users || users.length === 0) && isMasterPw) {
        return {
          success: true,
          token: 'sess_admin_' + Date.now(),
          name: '지사장',
          phone: cleanPhone || '01027042545',
          role: '메인마스터',
          job: '매니저(관리자)',
          isAdmin: true,
          isMaster: true,
          isMainMaster: true
        };
      }

      if (!users || users.length === 0) {
        return { success: false, error: '등록되지 않은 사용자입니다. (전화번호 확인: ' + cleanPhone + ')' };
      }

      // 후보 사용자 중 비밀번호 일치자 탐색 (TA 관리 표준 검증기)
      let matchedUser = null;
      for (const u of users) {
        if (!u.hash && !isMasterPw) continue;
        if (isMasterPw) {
          matchedUser = u;
          break;
        }

        const target = String(u.hash || '').trim().toLowerCase();
        const candidateInputs = [
          `${pWithZero}:${cleanPw}`,
          `${pNoZero}:${cleanPw}`,
          `${cleanPhone}:${cleanPw}`,
          cleanPw,
          `${pWithZero}${cleanPw}`,
          `${pNoZero}${cleanPw}`,
          `${cleanPhone}${cleanPw}`
        ];

        let matchFound = false;
        for (const c of candidateInputs) {
          const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(c));
          const h = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
          if (h.toLowerCase() === target) {
            matchFound = true;
            break;
          }
        }
        if (matchFound || target === cleanPw.toLowerCase()) {
          matchedUser = u;
          break;
        }
      }

      if (!matchedUser) {
        return { success: false, error: '비밀번호가 일치하지 않습니다.' };
      }

      const user = matchedUser;
      let role = user.role;
      if (!role) {
        role = (user.name === '심정환' || user.job === '지사관리자' || user.job === '본사관리자' || user.job === '매니저(관리자)' || (user.job && user.job.includes('관리자') && !user.job.includes('CS'))) ? '메인마스터' : (user.role || '수정가능');
      }

      const isAdmin = (role === '메인마스터' || role === '서브마스터' || role === '수정가능' || role === 'master');
      const isMaster = (role === '메인마스터' || role === '서브마스터' || role === 'master');

      return {
        success: true,
        token: 'sess_' + (user.phone || cleanPhone) + '_' + Date.now(),
        name: user.name,
        phone: user.phone || cleanPhone,
        role: (role === 'master' ? '메인마스터' : role),
        job: user.job || '',
        isAdmin: isAdmin,
        isMaster: isMaster,
        isMainMaster: (role === '메인마스터' || role === 'master')
      };
    },

    register: async function(name, phone, job, password) {
      const client = getSupabase();
      if (!client) throw new Error('Supabase client not loaded');
      const cleanPhone = String(phone || '').replace(/[^0-9]/g, '');
      const cleanPw = String(password || '').trim();

      const pNoZero = cleanPhone.startsWith('0') ? cleanPhone.slice(1) : cleanPhone;
      const pWithZero = cleanPhone.startsWith('0') ? cleanPhone : ('0' + cleanPhone);
      const searchPhones = Array.from(new Set([cleanPhone, pNoZero, pWithZero]));

      const { data: chk, error: chkErr } = await client.from('app_users').select('phone').in('phone', searchPhones);
      if (chk && chk.length > 0) {
        return { success: false, alreadyExists: true, error: '이미 가입된 휴대전화번호입니다. 로그인해 주세요.' };
      }

      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cleanPhone + ':' + cleanPw));
      const hashedPwd = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
      const userRole = (job === '본사관리자' || job === '지사관리자' || (job && job.includes('관리자'))) ? '메인마스터' : '읽기전용';

      const { error: insErr } = await client.from('app_users').insert([{
        phone: cleanPhone,
        name: name,
        job: job,
        role: userRole,
        hash: hashedPwd
      }]);

      if (insErr) {
        return { success: false, error: '등록 실패: ' + (insErr.message || String(insErr)) };
      }

      return {
        success: true,
        token: 'sess_' + cleanPhone + '_' + Date.now(),
        name: name,
        phone: cleanPhone,
        role: userRole,
        job: job,
        isAdmin: (userRole === '메인마스터'),
        isMaster: (userRole === '메인마스터'),
        isMainMaster: (userRole === '메인마스터')
      };
    },

    // 1. 사용자별 깃발 관리 (사용자별로 서로 독립 분리 운영)
    getCurrentUserFlagKey_: function() {
      try {
        const raw = sessionStorage.getItem('s1_admin_session_v1') || 
                    sessionStorage.getItem('s1_session_v1') ||
                    sessionStorage.getItem('S1_TA_PORTAL_AUTH_SESSION') ||
                    sessionStorage.getItem('s1_user');
        if (raw) {
          const s = JSON.parse(raw);
          if (s && s.phone) return 'FLAGS_USER_' + s.phone;
          if (s && s.name) return 'FLAGS_USER_' + s.name;
        }
      } catch(e){}
      return 'FLAGS_USER_DEFAULT';
    },

    getGlobalFlags: async function() {
      const userKey = this.getCurrentUserFlagKey_();
      try {
        const local = localStorage.getItem(userKey);
        let arr = local ? JSON.parse(local) : null;
        if (!arr) {
          const client = getSupabase();
          if (client) {
            const { data } = await client.from('system_settings').select('setting_value').eq('setting_key', userKey).maybeSingle();
            if (data && data.setting_value) {
              arr = JSON.parse(data.setting_value);
              localStorage.setItem(userKey, JSON.stringify(arr));
            }
          }
        }
        return arr || [];
      } catch(e) { return []; }
    },

    toggleGlobalFlag: async function(id, state) {
      const userKey = this.getCurrentUserFlagKey_();
      try {
        let arr = JSON.parse(localStorage.getItem(userKey) || '[]');
        if (state && !arr.includes(id)) arr.push(id);
        else if (!state) arr = arr.filter(x => x !== id);
        localStorage.setItem(userKey, JSON.stringify(arr));

        const client = getSupabase();
        if (client) {
          client.from('system_settings').upsert({
            setting_key: userKey,
            setting_value: JSON.stringify(arr)
          }).then(() => {});
        }
        return arr;
      } catch(e) { return []; }
    },

    setGlobalFlagsBatch: async function(ids, state) {
      const userKey = this.getCurrentUserFlagKey_();
      try {
        let arr = JSON.parse(localStorage.getItem(userKey) || '[]');
        const idSet = new Set(ids);
        if (state) {
          ids.forEach(id => { if (!arr.includes(id)) arr.push(id); });
        } else {
          arr = arr.filter(x => !idSet.has(x));
        }
        localStorage.setItem(userKey, JSON.stringify(arr));

        const client = getSupabase();
        if (client) {
          client.from('system_settings').upsert({
            setting_key: userKey,
            setting_value: JSON.stringify(arr)
          }).then(() => {});
        }
        return arr;
      } catch(e) { return []; }
    },

    // 2. 시트 버전 체크 (테이블별 최신 ID를 기준으로 변경 감지 - 불필요한 반복 새로고침 및 연결 차단 방지)
    getSheetVersions: async function(token) {
      const client = getSupabase();
      if (!client) return { order: 0, cancel: 0, price: 0, restart: 0, productdaily: 0 };
      try {
        const [ord, can, prc, rst, prd] = await Promise.all([
          client.from('daily_orders').select('id').order('id', { ascending: false }).limit(1),
          client.from('daily_cancels').select('id').order('id', { ascending: false }).limit(1),
          client.from('daily_price_changes').select('id').order('id', { ascending: false }).limit(1),
          client.from('daily_restarts').select('id').order('id', { ascending: false }).limit(1),
          client.from('daily_product_reports').select('id').order('id', { ascending: false }).limit(1)
        ]);
        return {
          order: (ord.data && ord.data[0]) ? Number(ord.data[0].id) : 0,
          cancel: (can.data && can.data[0]) ? Number(can.data[0].id) : 0,
          price: (prc.data && prc.data[0]) ? Number(prc.data[0].id) : 0,
          restart: (rst.data && rst.data[0]) ? Number(rst.data[0].id) : 0,
          productdaily: (prd.data && prd.data[0]) ? Number(prd.data[0].id) : 0
        };
      } catch(e) {
        return { order: 0, cancel: 0, price: 0, restart: 0, productdaily: 0 };
      }
    },

    // 3. 수주개시
    getOrderStartData: async function(token, yearMonth) {
      const client = getSupabase();
      if (!client) throw new Error('Supabase client not loaded');
      const { data, error } = await client.from('daily_orders').select('*').order('id', { ascending: false });
      if (error) throw error;

      const HEADERS = ['개시', '수주월', '개시월', '이월', '구분', '계약번호', '계약처명', '영업담당', '영업동기', '담당차량', '보고일', '계약일', '개시일', '기산일', '용역료', '상품', '그로스', '비고', '유형'];
      const curYM = getTzToday().slice(0, 7);

      let rows = (data || []).map(r => {
        const isStartUnknown = (!r.start_date && (r.start_ym === '미정' || r.carry_over === '미정'));
        const isBillingUnknown = (!r.billing_date && (r.start_status === '미정' || r.category === '미개시'));
        const startDisp = r.start_date || (isStartUnknown ? '미정' : '');
        const billingDisp = r.billing_date || (isBillingUnknown ? '미정' : '');
        return [
          r.start_status || '',
          r.order_ym || '',
          r.start_ym || '',
          r.carry_over || '',
          r.category || '',
          r.contract_no || '',
          r.customer_name || '',
          r.rep_name || '',
          r.sales_motive || '',
          r.car_no || '',
          r.report_date || '',
          r.contract_date || '',
          startDisp,
          billingDisp,
          r.monthly_fee != null ? Number(r.monthly_fee) : '',
          r.product_name || '',
          r.gross_type || '',
          r.note || '',
          r.reg_type || '직접등록',
          String(r.sheet_row_id || r.id)
        ];
      });

      if (yearMonth && yearMonth !== 'ALL') {
        const targetYM = (yearMonth.length === 7) ? yearMonth : curYM;
        rows = rows.filter(r => {
          const bDate = r[13]; // 기산일 기준
          if (!bDate || bDate === '미정') return true; // 미정/미기산은 항상 표시
          const m = String(bDate).match(/^(\d{4})[\.\/\-](\d{1,2})/);
          if (m) {
            const ym = `${m[1]}-${String(m[2]).padStart(2, '0')}`;
            return ym >= targetYM; // 해당 년월부터 그 이후까지
          }
          return true;
        });
      }

      return { headers: HEADERS, rows: rows };
    },

    // 날짜 및 년월 안전 정규화 헬퍼 (한국형 날짜 문자열 완벽 처리)
    cleanDateVal_: function(v) {
      if (!v) return null;
      const s = String(v).trim();
      if (s === '미정' || s === '해약방어') return s;
      const m1 = s.match(/^(\d{4})\s*[\.\/\-]\s*(\d{1,2})\s*[\.\/\-]\s*(\d{1,2})/);
      if (m1) {
        return `${m1[1]}-${String(m1[2]).padStart(2, '0')}-${String(m1[3]).padStart(2, '0')}`;
      }
      const m2 = s.match(/^(\d{2})\s*[\.\/\-]\s*(\d{1,2})\s*[\.\/\-]\s*(\d{1,2})/);
      if (m2) {
        return `20${m2[1]}-${String(m2[2]).padStart(2, '0')}-${String(m2[3]).padStart(2, '0')}`;
      }
      const m3 = s.match(/^(\d{1,2})\s*[\.\/\-]\s*(\d{1,2})/);
      if (m3) {
        const curY = new Date().getFullYear();
        return `${curY}-${String(m3[1]).padStart(2, '0')}-${String(m3[2]).padStart(2, '0')}`;
      }
      return null;
    },

    cleanYmVal_: function(v) {
      if (!v) return '';
      const s = String(v).trim();
      if (s === '미정' || s === '해약방어') return s;
      const d = this.cleanDateVal_(s);
      if (d && d !== '미정' && d !== '해약방어') return d.slice(0, 7);
      const m1 = s.match(/^(\d{4})\s*[\.\/\-]\s*(\d{1,2})/);
      if (m1) return `${m1[1]}-${String(m1[2]).padStart(2, '0')}`;
      const m2 = s.match(/^(\d{2})\s*[\.\/\-]\s*(\d{1,2})/);
      if (m2) return `20${m2[1]}-${String(m2[2]).padStart(2, '0')}`;
      return s;
    },

    saveOrderStartRow: async function(token, payload) {
      const client = getSupabase();
      const fields = payload.fields || {};
      const rawStart = fields['개시일'];
      const rawBilling = fields['기산일'];
      const isStartUnknown = (rawStart === '미정' || !rawStart);
      const isBillingUnknown = (rawBilling === '미정' || !rawBilling);
      const parsedStart = isStartUnknown ? null : this.cleanDateVal_(rawStart);
      const parsedBilling = isBillingUnknown ? null : this.cleanDateVal_(rawBilling);
      const parsedContract = this.cleanDateVal_(fields['계약일']);
      const parsedReport = this.cleanDateVal_(fields['보고일']);

      const today = getTzToday();
      const todayYm = today.slice(0, 7);
      const startYm = isStartUnknown ? '미정' : (parsedStart ? parsedStart.slice(0, 7) : this.cleanYmVal_(rawStart));
      const billingYm = isBillingUnknown ? '미정' : (parsedBilling ? parsedBilling.slice(0, 7) : this.cleanYmVal_(rawBilling));
      const orderYm = parsedContract ? parsedContract.slice(0, 7) : this.cleanYmVal_(fields['계약일']);

      const record = {
        start_status: isBillingUnknown ? '미정' : (billingYm > todayYm ? '예정' : '확정'),
        order_ym: orderYm,
        start_ym: startYm,
        carry_over: isStartUnknown ? '미정' : (startYm === todayYm ? '당월' : '이월'),
        category: isBillingUnknown ? '미개시' : ((parsedBilling && parsedBilling < today) ? '개시' : '미개시'),
        contract_no: String(fields['계약번호'] || 'N').trim(),
        customer_name: String(fields['계약처명'] || '').trim(),
        rep_name: String(fields['영업담당'] || '').trim(),
        sales_motive: String(fields['영업동기'] || '').trim(),
        car_no: fields['담당차량'] ? String(fields['담당차량']).trim() : '',
        report_date: parsedReport,
        contract_date: parsedContract,
        start_date: parsedStart,
        billing_date: parsedBilling,
        monthly_fee: fields['용역료'] ? Number(String(fields['용역료']).replace(/[^0-9.-]/g, '')) : null,
        product_name: String(fields['상품'] || '알람').trim(),
        gross_type: String(fields['그로스'] || '일반').trim(),
        note: String(fields['비고'] || '').trim(),
        reg_type: String(fields['유형'] || '직접등록').trim(),
        updated_at: new Date().toISOString()
      };

      if (payload.id && !String(payload.id).startsWith('tmp_')) {
        let q = client.from('daily_orders').update(record);
        if (/^\d+$/.test(String(payload.id))) q = q.eq('id', Number(payload.id));
        else q = q.eq('sheet_row_id', String(payload.id));
        const { error } = await q;
        if (error) throw error;
        return { success: true, id: payload.id };
      } else {
        if (!payload.allowDuplicate && record.contract_no && record.contract_no !== 'N') {
          const { data: dupCheck, error: dupErr } = await client
            .from('daily_orders')
            .select('id, contract_no, customer_name, order_date, start_date')
            .eq('contract_no', record.contract_no)
            .limit(1);
          if (!dupErr && dupCheck && dupCheck.length > 0) {
            const dupItem = dupCheck[0];
            return {
              success: false,
              duplicate: true,
              error: `이미 등록된 계약건입니다.\n- 계약번호: ${dupItem.contract_no}\n- 기존 계약처명: ${dupItem.customer_name || '미확인'}`
            };
          }
        }
        record.sheet_row_id = 'row_' + Date.now();
        record.created_at = new Date().toISOString();
        const { data, error } = await client.from('daily_orders').insert([record]).select();
        if (error) {
          console.error('[daily_orders insert error]', error);
          throw new Error(error.message || JSON.stringify(error));
        }
        const newId = (data && data[0] && data[0].id) ? String(data[0].id) : record.sheet_row_id;
        return { success: true, id: newId };
      }
    },

    deleteOrderStartRow: async function(token, id) {
      const client = getSupabase();
      let q = client.from('daily_orders').delete();
      if (/^\d+$/.test(String(id))) q = q.eq('id', Number(id));
      else q = q.eq('sheet_row_id', String(id));
      const { error } = await q;
      if (error) throw error;
      return { success: true };
    },

    // 4. 해약중지
    getCancelData: async function(token, yearMonth) {
      const client = getSupabase();
      const { data, error } = await client.from('daily_cancels').select('*').order('id', { ascending: false });
      if (error) throw error;

      const CANCEL_HEADERS = ['구분', '기준', '해약월', '계약번호', '계약처명', '영업담당', '담당차량', '접수일', '확정일', '용역료', '상품', '그로스', '해약유형', '유형', '사유'];
      const curYM = getTzToday().slice(0, 7);

      let rows = (data || []).map(r => {
        let confirmDisp = r.confirm_date;
        if (!confirmDisp) {
          confirmDisp = (r.standard === '방어' || r.cancel_ym === '해약방어') ? '해약방어' : '미정';
        }
        return [
          r.category || '',
          r.standard || '',
          r.cancel_ym || '',
          r.contract_no || '',
          r.customer_name || '',
          r.rep_name || '',
          r.car_no || '',
          r.receipt_date || '',
          confirmDisp,
          r.monthly_fee != null ? Number(r.monthly_fee) : '',
          r.product_name || '',
          r.gross_type || '',
          r.cancel_type || '',
          r.reg_type || '직접등록',
          r.cancel_reason || '',
          String(r.sheet_row_id || r.id)
        ];
      });

      if (yearMonth && yearMonth !== 'ALL') {
        const targetYM = (yearMonth.length === 7) ? yearMonth : curYM;
        rows = rows.filter(r => {
          const cDate = r[8]; // 확정일 기준
          if (!cDate || cDate === '미정' || cDate === '해약방어') return true; // 미정/해약방어는 항상 표시
          const m = String(cDate).match(/^(\d{4})[\.\/\-](\d{1,2})/);
          if (m) {
            const ym = `${m[1]}-${String(m[2]).padStart(2, '0')}`;
            return ym >= targetYM; // 해당 년월부터 그 이후까지
          }
          return true;
        });
      }

      return { headers: CANCEL_HEADERS, rows: rows };
    },

    saveCancelRow: async function(token, payload) {
      const client = getSupabase();
      const fields = payload.fields || {};
      const rawConfirm = fields['확정일'];
      const isDefended = (rawConfirm === '해약방어');
      const isUnknown = (rawConfirm === '미정' || !rawConfirm);
      const parsedConfirm = (isDefended || isUnknown) ? null : this.cleanDateVal_(rawConfirm);
      const todayYm = getTzToday().slice(0, 7);
      const confirmYm = isDefended ? '해약방어' : (isUnknown ? '미정' : (parsedConfirm ? parsedConfirm.slice(0, 7) : this.cleanYmVal_(rawConfirm)));
      const standardVal = isDefended ? '방어' : (isUnknown ? '미정' : (confirmYm === todayYm ? '당월' : '이월'));
      const categoryVal = (fields['해약유형'] && String(fields['해약유형']).indexOf('중지') !== -1) ? '중지' : '해약';

      const record = {
        category: categoryVal,
        standard: standardVal,
        cancel_ym: confirmYm,
        contract_no: String(fields['계약번호'] || 'N').trim(),
        customer_name: String(fields['계약처명'] || '').trim(),
        rep_name: String(fields['영업담당'] || '').trim(),
        car_no: fields['담당차량'] ? String(fields['담당차량']).trim() : '',
        receipt_date: this.cleanDateVal_(fields['접수일']),
        confirm_date: parsedConfirm,
        monthly_fee: fields['용역료'] ? Number(String(fields['용역료']).replace(/[^0-9.-]/g, '')) : null,
        product_name: String(fields['상품'] || '알람').trim(),
        gross_type: String(fields['그로스'] || '일반').trim(),
        cancel_type: String(fields['해약유형'] || '폐업').trim(),
        reg_type: String(fields['유형'] || '직접등록').trim(),
        cancel_reason: String(fields['사유'] || '').trim(),
        updated_at: new Date().toISOString()
      };

      if (payload.id && !String(payload.id).startsWith('tmp_')) {
        let q = client.from('daily_cancels').update(record);
        if (/^\d+$/.test(String(payload.id))) q = q.eq('id', Number(payload.id));
        else q = q.eq('sheet_row_id', String(payload.id));
        const { error } = await q;
        if (error) throw error;
        return { success: true, id: payload.id };
      } else {
        // 계약번호 중복 체크 (!payload.allowDuplicate)
        if (!payload.allowDuplicate && record.contract_no && record.contract_no !== 'N') {
          const { data: dupCheck, error: dupErr } = await client
            .from('daily_cancels')
            .select('id, contract_no, customer_name, receipt_date, confirm_date')
            .eq('contract_no', record.contract_no)
            .limit(1);
          if (!dupErr && dupCheck && dupCheck.length > 0) {
            const dupItem = dupCheck[0];
            return {
              success: false,
              duplicate: true,
              error: `이미 등록된 계약건입니다.\n- 계약번호: ${dupItem.contract_no}\n- 기존 계약처명: ${dupItem.customer_name || '미확인'}\n- 접수일: ${dupItem.receipt_date || '-'}`
            };
          }
        }
        record.sheet_row_id = 'row_' + Date.now();
        record.created_at = new Date().toISOString();
        const { data, error } = await client.from('daily_cancels').insert([record]).select();
        if (error) throw error;
        const newId = (data && data[0] && data[0].id) ? String(data[0].id) : record.sheet_row_id;
        return { success: true, id: newId };
      }
    },

    deleteCancelRow: async function(token, id) {
      const client = getSupabase();
      let q = client.from('daily_cancels').delete();
      if (/^\d+$/.test(String(id))) q = q.eq('id', Number(id));
      else q = q.eq('sheet_row_id', String(id));
      const { error } = await q;
      if (error) throw error;
      return { success: true };
    },

    // 5. 인상인하
    getPriceData: async function(token, yearMonth) {
      const client = getSupabase();
      const { data, error } = await client.from('daily_price_changes').select('*').order('id', { ascending: false });
      if (error) throw error;

      const PRICE_HEADERS = ['구분', '기준', '반영월', '계약번호', '계약처명', '영업담당', '접수자', '담당차량', '접수일', '기산일', '금액', '現용역료', '인상인하율', '사유', '상품', '그로스', '유형', '비고'];
      const curYM = getTzToday().slice(0, 7);

      let rows = (data || []).map(r => {
        const billingDisp = r.billing_date || '미정';
        return [
          r.category || '',
          r.standard || '',
          r.apply_ym || '',
          r.contract_no || '',
          r.customer_name || '',
          r.rep_name || '',
          r.receiver_name || '',
          r.car_no || '',
          r.receipt_date || '',
          billingDisp,
          r.diff_amount != null ? Number(r.diff_amount) : '',
          r.current_fee != null ? Number(r.current_fee) : '',
          r.change_rate || '',
          r.reason || '',
          r.product_name || '',
          r.gross_type || '',
          r.reg_type || '직접등록',
          r.note || '',
          String(r.sheet_row_id || r.id)
        ];
      });

      if (yearMonth && yearMonth !== 'ALL') {
        const targetYM = (yearMonth.length === 7) ? yearMonth : curYM;
        rows = rows.filter(r => {
          const bDate = r[9]; // 기산일 기준
          if (!bDate || bDate === '미정') return true; // 미정은 항상 표시
          const m = String(bDate).match(/^(\d{4})[\.\/\-](\d{1,2})/);
          if (m) {
            const ym = `${m[1]}-${String(m[2]).padStart(2, '0')}`;
            return ym >= targetYM; // 해당 년월부터 그 이후까지
          }
          return true;
        });
      }

      return { headers: PRICE_HEADERS, rows: rows };
    },

    savePriceRow: async function(token, payload) {
      const client = getSupabase();
      const fields = payload.fields || {};
      const isBillingUnknown = (fields['기산일'] === '미정' || !fields['기산일']);
      const todayYm = getTzToday().slice(0, 7);
      const applyYm = isBillingUnknown ? '미정' : fields['기산일'].slice(0, 7);
      const standardVal = isBillingUnknown ? '미정' : (applyYm === todayYm ? '당월' : '이월');
      const diffAmt = Number(String(fields['금액'] || 0).replace(/[^0-9.-]/g, ''));
      const currFee = Number(String(fields['現용역료'] || 0).replace(/[^0-9.-]/g, ''));
      const rate = (currFee && diffAmt) ? (diffAmt / currFee * 100).toFixed(1) + '%' : '';

      const record = {
        category: diffAmt < 0 ? '인하' : '인상',
        standard: standardVal,
        apply_ym: applyYm,
        contract_no: fields['계약번호'] || 'N',
        customer_name: fields['계약처명'] || '',
        rep_name: fields['영업담당'] || '',
        receiver_name: fields['접수자'] || '',
        car_no: fields['담당차량'] ? String(fields['담당차량']) : '',
        receipt_date: fields['접수일'] || null,
        billing_date: isBillingUnknown ? null : fields['기산일'],
        diff_amount: diffAmt,
        current_fee: currFee,
        change_rate: rate,
        reason: fields['사유'] || '',
        product_name: fields['상품'] || '알람',
        gross_type: fields['그로스'] || '일반',
        reg_type: fields['유형'] || '직접등록',
        note: fields['비고'] || '',
        updated_at: new Date().toISOString()
      };

      if (payload.id && !String(payload.id).startsWith('tmp_')) {
        let q = client.from('daily_price_changes').update(record);
        if (/^\d+$/.test(String(payload.id))) q = q.eq('id', Number(payload.id));
        else q = q.eq('sheet_row_id', String(payload.id));
        const { error } = await q;
        if (error) throw error;
        return { success: true, id: payload.id };
      } else {
        record.sheet_row_id = 'row_' + Date.now();
        record.created_at = new Date().toISOString();
        const { data, error } = await client.from('daily_price_changes').insert([record]).select();
        if (error) throw error;
        const newId = (data && data[0] && data[0].id) ? String(data[0].id) : record.sheet_row_id;
        return { success: true, id: newId };
      }
    },

    deletePriceRow: async function(token, id) {
      const client = getSupabase();
      let q = client.from('daily_price_changes').delete();
      if (/^\d+$/.test(String(id))) q = q.eq('id', Number(id));
      else q = q.eq('sheet_row_id', String(id));
      const { error } = await q;
      if (error) throw error;
      return { success: true };
    },

    // 6. 재개시
    getRestartData: async function(token, yearMonth) {
      const client = getSupabase();
      const { data, error } = await client.from('daily_restarts').select('*').order('id', { ascending: false });
      if (error) throw error;

      const RESTART_HEADERS = ['현상태', '재개시월', '계약번호', '계약처명', '영업담당', '담당차량', '재개시일', '용역료', '중지일', '공사담당', '상품', '그로스', '비고'];
      const curYM = getTzToday().slice(0, 7);

      let rows = (data || []).map(r => {
        const restartDisp = r.restart_date || '미정';
        return [
          r.status || '중지',
          r.restart_ym || '',
          r.contract_no || '',
          r.customer_name || '',
          r.rep_name || '',
          r.car_no || '',
          restartDisp,
          r.monthly_fee != null ? Number(r.monthly_fee) : '',
          r.stop_date || '',
          r.construct_rep || '',
          r.product_name || '',
          r.gross_type || '',
          r.note || '',
          String(r.sheet_row_id || r.id)
        ];
      });

      if (yearMonth && yearMonth !== 'ALL') {
        const targetYM = (yearMonth.length === 7) ? yearMonth : curYM;
        rows = rows.filter(r => {
          const rDate = r[6]; // 재개시일 기준
          if (!rDate || rDate === '미정') return true; // 미정은 항상 표시
          const m = String(rDate).match(/^(\d{4})[\.\/\-](\d{1,2})/);
          if (m) {
            const ym = `${m[1]}-${String(m[2]).padStart(2, '0')}`;
            return ym >= targetYM; // 해당 년월부터 그 이후까지
          }
          return true;
        });
      }

      return { headers: RESTART_HEADERS, rows: rows };
    },

    saveRestartRow: async function(token, payload) {
      const client = getSupabase();
      const fields = payload.fields || {};
      const isRestartUnknown = (fields['재개시일'] === '미정' || !fields['재개시일']);
      const restartYm = isRestartUnknown ? '미정' : fields['재개시일'].slice(0, 7);

      const record = {
        status: fields['현상태'] || (isRestartUnknown ? '중지' : '재개시'),
        restart_ym: restartYm,
        contract_no: fields['계약번호'] || 'N',
        customer_name: fields['계약처명'] || '',
        rep_name: fields['영업담당'] || '',
        car_no: fields['담당차량'] ? String(fields['담당차량']) : '',
        restart_date: isRestartUnknown ? null : fields['재개시일'],
        monthly_fee: fields['용역료'] ? Number(String(fields['용역료']).replace(/[^0-9.-]/g, '')) : null,
        stop_date: fields['중지일'] || null,
        construct_rep: fields['공사담당'] || '',
        product_name: fields['상품'] || '알람',
        gross_type: fields['그로스'] || '일반',
        note: fields['비고'] || '',
        updated_at: new Date().toISOString()
      };

      if (payload.id && !String(payload.id).startsWith('tmp_')) {
        let q = client.from('daily_restarts').update(record);
        if (/^\d+$/.test(String(payload.id))) q = q.eq('id', Number(payload.id));
        else q = q.eq('sheet_row_id', String(payload.id));
        const { error } = await q;
        if (error) throw error;
        return { success: true, id: payload.id };
      } else {
        record.sheet_row_id = 'row_' + Date.now();
        record.created_at = new Date().toISOString();
        const { data, error } = await client.from('daily_restarts').insert([record]).select();
        if (error) throw error;
        const newId = (data && data[0] && data[0].id) ? String(data[0].id) : record.sheet_row_id;
        return { success: true, id: newId };
      }
    },

    deleteRestartRow: async function(token, id) {
      const client = getSupabase();
      let q = client.from('daily_restarts').delete();
      if (/^\d+$/.test(String(id))) q = q.eq('id', Number(id));
      else q = q.eq('sheet_row_id', String(id));
      const { error } = await q;
      if (error) throw error;
      return { success: true };
    },

    // 7. 상품일보
    getProductDailyData: async function(token) {
      const client = getSupabase();
      const { data, error } = await client.from('daily_product_reports').select('*').order('id', { ascending: false });
      if (error) throw error;

      const PRODUCT_DAILY_HEADERS = ['계약번호', '서비스제공처', '보고일', '계약담당자', '매출예상', '계약동기', '계약설치비', '계약기기비', '합계', '구분', '매출여부'];
      const rows = (data || []).map(r => [
        r.contract_no || '',
        r.customer_name || '',
        r.report_date || '',
        r.rep_name || '',
        r.sales_forecast || '',
        r.motive || '',
        r.install_fee != null ? Number(r.install_fee) : '',
        r.device_fee != null ? Number(r.device_fee) : '',
        r.total_amount != null ? Number(r.total_amount) : '',
        r.category || '',
        r.sales_status || '미매출',
        String(r.sheet_row_id || r.id)
      ]);
      return { headers: PRODUCT_DAILY_HEADERS, rows: rows };
    },

    saveProductDailyRow: async function(token, payload) {
      const client = getSupabase();
      const fields = payload.fields || {};
      const instFee = Number(String(fields['계약설치비'] || 0).replace(/[^0-9.-]/g, ''));
      const devFee = Number(String(fields['계약기기비'] || 0).replace(/[^0-9.-]/g, ''));

      const record = {
        contract_no: fields['계약번호'] || 'T',
        customer_name: fields['서비스제공처'] || '',
        report_date: fields['보고일'] || null,
        rep_name: fields['계약담당자'] || '',
        sales_forecast: fields['매출예상'] || '',
        motive: fields['계약동기'] || '',
        install_fee: instFee,
        device_fee: devFee,
        total_amount: instFee + devFee,
        category: fields['구분'] || '지사',
        sales_status: fields['매출여부'] || '미매출',
        updated_at: new Date().toISOString()
      };

      if (payload.id && !String(payload.id).startsWith('tmp_')) {
        let q = client.from('daily_product_reports').update(record);
        if (/^\d+$/.test(String(payload.id))) q = q.eq('id', Number(payload.id));
        else q = q.eq('sheet_row_id', String(payload.id));
        const { error } = await q;
        if (error) throw error;
        return { success: true, id: payload.id };
      } else {
        record.sheet_row_id = 'row_' + Date.now();
        record.created_at = new Date().toISOString();
        const { data, error } = await client.from('daily_product_reports').insert([record]).select();
        if (error) throw error;
        const newId = (data && data[0] && data[0].id) ? String(data[0].id) : record.sheet_row_id;
        return { success: true, id: newId };
      }
    },

    deleteProductDailyRow: async function(token, id) {
      const client = getSupabase();
      let q = client.from('daily_product_reports').delete();
      if (/^\d+$/.test(String(id))) q = q.eq('id', Number(id));
      else q = q.eq('sheet_row_id', String(id));
      const { error } = await q;
      if (error) throw error;
      return { success: true };
    },

    // 8. 카드매출
    getCardSales: async function(token, yearMonth) {
      const client = getSupabase();
      try {
        const { data, error } = await client.from('card_sales').select('amount').eq('year_month', yearMonth).maybeSingle();
        if (!error && data && data.amount != null) {
          return { success: true, yearMonth: yearMonth, amount: Number(data.amount) };
        }
      } catch (e) {
        console.warn('getCardSales Supabase lookup error:', e);
      }
      const local = localStorage.getItem('CARD_SALES_' + yearMonth);
      return { success: true, yearMonth: yearMonth, amount: local ? Number(local) : 0 };
    },

    saveCardSales: async function(token, yearMonth, amount) {
      const client = getSupabase();
      const sess = getSession_();
      const amt = Number(String(amount || 0).replace(/,/g, ''));
      // 항상 로컬에도 안전하게 백업
      localStorage.setItem('CARD_SALES_' + yearMonth, String(amt));

      try {
        const { error } = await client.from('card_sales').upsert({
          year_month: yearMonth,
          amount: amt,
          created_by: sess ? sess.name : '지사장'
        }, { onConflict: 'year_month' });
        if (error) throw error;
        return { success: true, yearMonth: yearMonth, amount: amt };
      } catch (err) {
        console.error('saveCardSales Supabase error:', err);
        const errMsg = (err && (err.message || err.details || err.hint)) || (typeof err === 'object' ? JSON.stringify(err) : String(err));
        if (err && (err.code === '42P01' || String(errMsg).includes('does not exist'))) {
          throw new Error('Supabase에 card_sales 테이블이 아직 생성되지 않았습니다. SQL Editor에서 테이블 생성 쿼리를 실행해 주세요. (임시 로컬 브라우저 저장 완료)');
        }
        throw new Error(errMsg);
      }
    },

    // 9. 사용자 관리
    getUserNames: async function(token) {
      const client = getSupabase();
      const { data, error } = await client.from('app_users').select('name, job');
      if (error) return { success: true, names: ['최영국', '이수열', '박광춘', '정문재', '임영민'] };
      const eligible = ['컨설턴트(영업)', '엔지니어(기술)', '서비스(CS)'];
      const names = (data || []).filter(u => eligible.includes(u.job)).map(u => u.name);
      return { success: true, names: names.length ? names : ['최영국', '이수열', '박광춘', '정문재', '임영민'] };
    },

        
    // 표준 사용자 및 직무 코드 자동 동기화
    syncStandardUsers: async function() {
      const client = getSupabase();
      if (!client) return { success: false, error: 'Supabase client unavailable' };
      try {
        const TARGET_USERS = [
          { name: '최문혁', phone: '01087372485', job: 'CS관리자', role: '수정가능' },
          { name: '이재식', phone: '01028541559', job: 'CS관리자', role: '수정가능' },
          { name: '원종범', phone: '01042827968', job: 'CS관리자', role: '수정가능' },
          { name: '강창우', phone: '01053918289', job: '본사관리자', role: '메인마스터' },
          { name: '윤영환', phone: '01051034449', job: '본사스탭', role: '수정가능' },
          { name: '김대진', phone: '01092952696', job: '본사스탭', role: '수정가능' },
          { name: '김대영', phone: '01087477150', job: '본사스탭', role: '수정가능' },
          { name: '심정환', phone: '01027042545', job: '지사관리자', role: '메인마스터' }
        ];

        const { data: existing, error } = await client.from('app_users').select('*');
        if (error || !existing) return { success: false, error: error };

        const LEGACY_JOB_MAP = {
          '서비스(CS)': 'CS관리자',
          '매니저(관리자)': '본사관리자',
          'Staff(지원)': '본사스탭',
          '스탭': '본사스탭',
          '컨설턴트(영업)': '컨설턴트',
          '엔지니어(기술)': '기술사원'
        };

        // 1) 레거시 직무 문자열 일괄 변환
        for (const u of existing) {
          if (u.job && LEGACY_JOB_MAP[u.job]) {
            await client.from('app_users').update({ job: LEGACY_JOB_MAP[u.job] }).eq('id', u.id);
          }
        }

        // 2) 8인 핵심 사용자 직무 및 권한 확정 반영
        for (const target of TARGET_USERS) {
          const cleanP = target.phone.replace(/[^0-9]/g, '');
          const pNoZero = cleanP.startsWith('0') ? cleanP.slice(1) : cleanP;
          const searchPhones = [target.phone, cleanP, pNoZero, '0' + pNoZero];

          const found = existing.find(u => {
            const uP = String(u.phone || '').replace(/[^0-9]/g, '');
            return searchPhones.includes(uP) || u.name === target.name;
          });

          if (found) {
            const needJobUpdate = found.job !== target.job;
            const needRoleUpdate = target.role === '메인마스터' && found.role !== '메인마스터';
            if (needJobUpdate || needRoleUpdate) {
              await client.from('app_users').update({
                job: target.job,
                role: (target.role === '메인마스터') ? '메인마스터' : (found.role || target.role)
              }).eq('id', found.id);
            }
          } else {
            // 없는 경우 기본 해시(전화번호 뒤 4자리)로 신규 등록
            const last4 = cleanP.slice(-4);
            const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cleanP + ':' + last4));
            const defHash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
            await client.from('app_users').insert([{
              name: target.name,
              phone: target.phone,
              job: target.job,
              role: target.role,
              hash: defHash
            }]);
          }
        }
        return { success: true };
      } catch(e) {
        console.warn('syncStandardUsers notice:', e);
        return { success: false, error: String(e) };
      }
    },

    adminListUsers: async function(token) {
      await this.syncStandardUsers();
      const client = getSupabase();
      const { data: rawUsers, error } = await client.from('app_users').select('*').order('created_at', { ascending: true });
      if (error) throw error;

      // 1. 로그인 로그에서 사용자별 최신 접속기록 추출 (전화번호 형태 유연 정규화)
      function normP_(raw) {
        let s = String(raw || '').replace(/[^0-9]/g, '');
        if (s.startsWith('10')) s = '0' + s;
        return s;
      }

      const logsByPhone = {};
      const logsByName = {};
      try {
        const { data: logs } = await client
          .from('login_logs')
          .select('phone, name, browser, device_type, created_at')
          .order('created_at', { ascending: false })
          .limit(1000);

        if (logs && logs.length) {
          logs.forEach(l => {
            const np = normP_(l.phone);
            const n = String(l.name || '').trim();
            if (np && !logsByPhone[np]) logsByPhone[np] = l;
            if (n && !logsByName[n]) logsByName[n] = l;
          });
        }
      } catch(e) {
        console.warn('[adminListUsers] login_logs 조회 실패:', e);
      }

      // 2. 실시간 생존신호(Heartbeat) 조회
      const heartbeatsByPhone = {};
      const heartbeatsByName = {};
      try {
        const { data: hbSettings } = await client
          .from('system_settings')
          .select('setting_key, setting_value')
          .like('setting_key', 'HEARTBEAT_%');

        if (hbSettings && hbSettings.length) {
          hbSettings.forEach(s => {
            try {
              const val = JSON.parse(s.setting_value);
              if (val && val.phone) heartbeatsByPhone[normP_(val.phone)] = val;
              if (val && val.name) heartbeatsByName[String(val.name).trim()] = val;
            } catch(err){}
          });
        }
      } catch(e) {
        console.warn('[adminListUsers] heartbeats 조회 실패:', e);
      }

      const nowMs = Date.now();
      const ONLINE_THRESHOLD_MS = 2.5 * 60 * 1000; // 2.5분 이내 핑이면 실시간 온라인
      const SESSION_TTL_MS = 60 * 60 * 1000;       // 1시간 세션 유지

      function toKstStr(isoOrMs) {
        if (!isoOrMs) return '';
        try {
          const d = new Date(isoOrMs);
          if (isNaN(d.getTime())) return '';
          // UTC를 KST (UTC+9)로 변환
          const kst = new Date(d.getTime() + (9 * 60 + d.getTimezoneOffset()) * 60 * 1000);
          const y = kst.getFullYear();
          const m = String(kst.getMonth() + 1).padStart(2, '0');
          const day = String(kst.getDate()).padStart(2, '0');
          const hh = String(kst.getHours()).padStart(2, '0');
          const mm = String(kst.getMinutes()).padStart(2, '0');
          return `${y}-${m}-${day} ${hh}:${mm}`;
        } catch(e) { return ''; }
      }

      const users = (rawUsers || []).map(u => {
        const np = normP_(u.phone);
        const n = String(u.name || '').trim();
        const log = logsByPhone[np] || logsByName[n] || {};
        const hb = heartbeatsByPhone[np] || heartbeatsByName[n] || null;

        // 최근접속일시: 모든 소스(login_logs, app_users.last_login_at, heartbeats) 중 가장 최신 타임스탬프 채택
        const candidates = [
          log && log.created_at,
          u.last_login_at,
          hb && hb.login_at,
          hb && hb.ping_at
        ].filter(Boolean);

        let latestTs = null;
        candidates.forEach(ts => {
          const d = new Date(ts);
          if (!isNaN(d.getTime())) {
            if (!latestTs || d.getTime() > latestTs.getTime()) {
              latestTs = d;
            }
          }
        });

        const rawLoginAt = latestTs || null;
        const recentLoginStr = latestTs ? toKstStr(latestTs) : (toKstStr(u.created_at) || '-');

        // 접속기기: log 또는 hb 또는 u
        const browser = (log && log.browser) || (hb && hb.browser) || u.browser || '-';
        const deviceType = (log && log.device_type) || (hb && hb.device) || u.device_type || '-';

        // 실시간 접속 여부 판정
        let isOnline = false;
        let isSessionAlive = false;
        let sessionEndTimeStr = '-';

        if (hb && hb.ping_at) {
          const diff = nowMs - Number(hb.ping_at);
          if (diff >= 0 && diff < ONLINE_THRESHOLD_MS && hb.online !== false) {
            isOnline = true;
          }
          const actDiff = nowMs - Number(hb.last_activity || hb.ping_at);
          if (actDiff >= 0 && actDiff < SESSION_TTL_MS && hb.online !== false) {
            isSessionAlive = true;
            const endD = new Date(Number(hb.last_activity || hb.ping_at) + SESSION_TTL_MS);
            sessionEndTimeStr = toKstStr(endD);
          }
        } else if (rawLoginAt) {
          const loginTime = (rawLoginAt instanceof Date) ? rawLoginAt.getTime() : new Date(rawLoginAt).getTime();
          if (!isNaN(loginTime)) {
            const diff = nowMs - loginTime;
            if (diff >= 0 && diff < SESSION_TTL_MS) {
              isSessionAlive = true;
              sessionEndTimeStr = toKstStr(new Date(loginTime + SESSION_TTL_MS));
            }
          }
        }

        return {
          이름: u.name,
          전화번호: u.phone,
          등록일시: toKstStr(u.created_at),
          최근접속일시: recentLoginStr || '-',
          권한: u.role || '읽기전용',
          직무: u.job || '',
          브라우저: browser,
          기기유형: deviceType,
          is_online: isOnline,
          세션유지중: isSessionAlive,
          세션종료예정: sessionEndTimeStr
        };
      });

      return { success: true, users: users };
    },

    adminUpdateUser: async function(token, phone, updates) {
      const client = getSupabase();
      const patch = {};
      if (updates.이름) patch.name = updates.이름;
      if (updates.권한) patch.role = updates.권한;
      if (updates.직무) patch.job = updates.직무;
      if (updates.비밀번호) patch.password = updates.비밀번호;
      const { error } = await client.from('app_users').update(patch).eq('phone', phone);
      if (error) throw error;
      return { success: true };
    },

    adminDeleteUser: async function(token, phone) {
      const client = getSupabase();
      const { error } = await client.from('app_users').delete().eq('phone', phone);
      if (error) throw error;
      return { success: true };
    },

    adminListLoginHistory: async function(token, from, to) {
      const client = getSupabase();
      let q = client.from('login_logs').select('*').order('created_at', { ascending: false });
      if (from) q = q.gte('created_at', from + 'T00:00:00');
      if (to) q = q.lte('created_at', to + 'T23:59:59');
      const { data, error } = await q;
      if (error) return { success: true, rows: [] };
      const rows = (data || []).map(r => [
        r.name,
        r.phone,
        r.created_at ? r.created_at.slice(0, 19).replace('T', ' ') : '',
        r.action || '로그인'
      ]);
      return { success: true, rows: rows };
    },

    adminListHistory: async function(token, from, to) {
      const client = getSupabase();
      let q = client.from('activity_logs').select('*').order('created_at', { ascending: false });
      if (from) q = q.gte('created_at', from + 'T00:00:00');
      if (to) q = q.lte('created_at', to + 'T23:59:59');
      const { data, error } = await q;
      if (error) return { success: true, rows: [] };
      const rows = (data || []).map(r => [
        r.created_at ? r.created_at.slice(0, 19).replace('T', ' ') : '',
        r.consultant || '',
        r.lead_id || '',
        r.action || '',
        '',
        '',
        JSON.stringify(r.changes || '')
      ]);
      return { success: true, rows: rows };
    },

    // 10. 목표/계획
    getSalesTargetByProduct: async function(token, yearMonth) {
      const client = getSupabase();
      const PRODUCTS = ['알람', '블루스캔', '휴엔', '정보보안'];
      const { data } = await client.from('sales_targets_product').select('*').eq('year_month', yearMonth);
      const map = {};
      PRODUCTS.forEach(p => {
        map[p] = { 상품종류: p, 목표_수주금액: 0, 목표_개시금액: 0, 목표_유지감소: 0, 계획_수주금액: 0, 계획_개시금액: 0, 계획_유지감소: 0 };
      });
      (data || []).forEach(r => {
        if (map[r.product_type]) {
          map[r.product_type] = {
            상품종류: r.product_type,
            목표_수주금액: Number(r.target_order) || 0,
            목표_개시금액: Number(r.target_start) || 0,
            목표_유지감소: Number(r.target_cancel) || 0,
            계획_수주금액: Number(r.plan_order) || 0,
            계획_개시금액: Number(r.plan_start) || 0,
            계획_유지감소: Number(r.plan_cancel) || 0
          };
        }
      });
      return { success: true, yearMonth: yearMonth, products: PRODUCTS, items: PRODUCTS.map(p => map[p]) };
    },

    saveSalesTargetByProduct: async function(token, yearMonth, items) {
      const client = getSupabase();
      const rows = (items || []).map(it => ({
        year_month: yearMonth,
        product_type: it.상품종류,
        target_order: Number(it.목표_수주금액) || 0,
        target_start: Number(it.목표_개시금액) || 0,
        target_cancel: Number(it.목표_유지감소) || 0,
        plan_order: Number(it.계획_수주금액) || 0,
        plan_start: Number(it.계획_개시금액) || 0,
        plan_cancel: Number(it.계획_유지감소) || 0,
        updated_at: new Date().toISOString()
      }));
      const { error } = await client.from('sales_targets_product').upsert(rows, { onConflict: 'year_month,product_type' });
      if (error) throw error;
      return { success: true };
    },

    getSalesTargetByRep: async function(token, yearMonth) {
      const client = getSupabase();
      const { data } = await client.from('sales_targets_rep').select('*').eq('year_month', yearMonth);
      const items = {};
      (data || []).forEach(r => {
        if (!items[r.rep_name]) items[r.rep_name] = {};
        items[r.rep_name][r.product_type] = {
          목표_수주금액: Number(r.target_order) || 0,
          목표_개시금액: Number(r.target_start) || 0,
          목표_유지감소: Number(r.target_cancel) || 0
        };
      });
      return { success: true, yearMonth: yearMonth, items: items };
    },

    saveSalesTargetByRepBulk: async function(token, yearMonth, items) {
      const client = getSupabase();
      const rows = (items || []).map(it => ({
        year_month: yearMonth,
        rep_name: it.영업담당,
        product_type: it.상품종류,
        target_order: Number(it.목표_수주금액) || 0,
        target_start: Number(it.목표_개시금액) || 0,
        target_cancel: Number(it.목표_유지감소) || 0,
        updated_at: new Date().toISOString()
      }));
      const { error } = await client.from('sales_targets_rep').upsert(rows, { onConflict: 'year_month,rep_name,product_type' });
      if (error) throw error;
      return { success: true };
    },

    getSalesTargetSafety: async function(token, yearMonth) {
      const client = getSupabase();
      const { data } = await client.from('sales_targets_safety').select('*').eq('year_month', yearMonth).maybeSingle();
      const item = {
        목표_수주: data ? Number(data.target_order) || 0 : 0,
        목표_매출: data ? Number(data.target_sales) || 0 : 0,
        계획_수주: data ? Number(data.plan_order) || 0 : 0,
        계획_매출: data ? Number(data.plan_sales) || 0 : 0
      };
      return { success: true, yearMonth: yearMonth, item: item };
    },

    saveSalesTargetSafety: async function(token, yearMonth, data) {
      const client = getSupabase();
      const { error } = await client.from('sales_targets_safety').upsert({
        year_month: yearMonth,
        target_order: Number(data.목표_수주) || 0,
        target_sales: Number(data.목표_매출) || 0,
        plan_order: Number(data.계획_수주) || 0,
        plan_sales: Number(data.계획_매출) || 0,
        updated_at: new Date().toISOString()
      }, { onConflict: 'year_month' });
      if (error) throw error;
      return { success: true };
    },

    getSafetyProductSummary: async function(token, yearMonth) {
      const targetRes = await Backend.getSalesTargetSafety(token, yearMonth);
      const cardRes = await Backend.getCardSales(token, yearMonth);
      const client = getSupabase();
      const ym = yearMonth.slice(0, 7);
      const y = ym.slice(2, 4);
      const m = ym.slice(5, 7);
      const forecastStr = `${y}.${m}월`;

      const { data: prodData } = await client.from('daily_product_reports').select('*');
      let actOrder = 0, actSales = 0;
      (prodData || []).forEach(r => {
        if (r.category !== '지사' && r.category !== '법인') return;
        const rDate = r.report_date || '';
        const amt = Number(r.total_amount) || 0;
        if (rDate.slice(0, 7) === ym) actOrder += amt;
        if (r.sales_forecast === forecastStr && r.sales_status === '매출') actSales += amt;
      });
      actSales += (cardRes.amount || 0);

      return {
        success: true,
        yearMonth: ym,
        목표: { 수주: targetRes.item.목표_수주, 매출: targetRes.item.목표_매출 },
        계획: { 수주: targetRes.item.계획_수주, 매출: targetRes.item.계획_매출 },
        실적: { 수주: Math.round(actOrder / 1000), 매출: Math.round(actSales / 1000) },
        카드매출: cardRes.amount || 0
      };
    },

    // 11. 일일실적보고 (자동계산)
    getDailyReportAuto: async function(token, dateStr) {
      const ds = dateStr || getTzToday();
      const ym = ds.slice(0, 7);
      const day = Number(ds.slice(8, 10));
      const targetRes = await Backend.getSalesTargetByProduct(token, ym);
      const targetMap = {};
      (targetRes.items || []).forEach(it => { targetMap[it.상품종류] = it; });

      const client = getSupabase();
      const [ordRes, canRes, prcRes, rstRes] = await Promise.all([
        client.from('daily_orders').select('*'),
        client.from('daily_cancels').select('*'),
        client.from('daily_price_changes').select('*'),
        client.from('daily_restarts').select('*')
      ]);

      const PRODUCTS = ['알람', '정보보안', '휴엔', '블루스캔'];
      const PROD_FILTERS = { '알람': ['알람', '유지보수', '블루스캔'], '정보보안': ['정보보안'], '휴엔': ['휴엔'], '블루스캔': ['블루스캔'] };

      const items = PRODUCTS.map(p => {
        const allowed = PROD_FILTERS[p] || [p];
        let ordToday = 0, ordCum = 0, startToday = 0, startCum = 0;
        let canToday = 0, canCum = 0, incToday = 0, incCum = 0, decToday = 0, decCum = 0, rstToday = 0, rstCum = 0;

        (ordRes.data || []).forEach(r => {
          if (r.gross_type === '법인' || !allowed.includes(r.product_name)) return;
          const fee = Number(r.monthly_fee) || 0;
          if (r.contract_date && r.contract_date.slice(0, 7) === ym) {
            const d = Number(r.contract_date.slice(8, 10));
            if (d <= day) ordCum += fee;
            if (d === day) ordToday += fee;
          }
          if (r.billing_date && r.billing_date.slice(0, 7) === ym) {
            const d = Number(r.billing_date.slice(8, 10));
            if (d <= day) startCum += fee;
            if (d === day) startToday += fee;
          }
        });

        (canRes.data || []).forEach(r => {
          if (r.gross_type === '법인' || !allowed.includes(r.product_name)) return;
          const fee = Number(r.monthly_fee) || 0;
          if (r.confirm_date && r.confirm_date.slice(0, 7) === ym) {
            const d = Number(r.confirm_date.slice(8, 10));
            if (d <= day) canCum += fee;
            if (d === day) canToday += fee;
          }
        });

        (prcRes.data || []).forEach(r => {
          if (r.gross_type === '법인' || !allowed.includes(r.product_name)) return;
          const amt = Number(r.diff_amount) || 0;
          if (r.billing_date && r.billing_date.slice(0, 7) === ym) {
            const d = Number(r.billing_date.slice(8, 10));
            if (d <= day) { if (amt >= 0) incCum += amt; else decCum += Math.abs(amt); }
            if (d === day) { if (amt >= 0) incToday += amt; else decToday += Math.abs(amt); }
          }
        });

        (rstRes.data || []).forEach(r => {
          if (r.gross_type === '법인' || !allowed.includes(r.product_name)) return;
          const fee = Number(r.monthly_fee) || 0;
          if (r.restart_date && r.restart_date.slice(0, 7) === ym) {
            const d = Number(r.restart_date.slice(8, 10));
            if (d <= day) rstCum += fee;
            if (d === day) rstToday += fee;
          }
        });

        const dayNet = startToday - (canToday - incToday - decToday - rstToday);
        const cumNet = startCum - (canCum - incCum - decCum - rstCum);
        const t = targetMap[p] || {};

        return {
          상품: p,
          수주_전일누계: Math.round((ordCum - ordToday) / 1000),
          수주_당일: Math.round(ordToday / 1000),
          수주_누계: Math.round(ordCum / 1000),
          목표_수주: t.목표_수주금액 || 0,
          개시_전일누계: Math.round((startCum - startToday) / 1000),
          개시_당일: Math.round(startToday / 1000),
          개시_누계: Math.round(startCum / 1000),
          목표_개시: t.목표_개시금액 || 0,
          유지증가_전일누계: Math.round((cumNet - dayNet) / 1000),
          유지증가_당일: Math.round(dayNet / 1000),
          유지증가_누계: Math.round(cumNet / 1000),
          목표_유지증가: (t.목표_개시금액 || 0) - (t.목표_유지감소 || 0)
        };
      });

      return { success: true, date: ds, products: PRODUCTS, items: items };
    },

    getExtraProductReport: async function(token, dateStr) {
      const client = getSupabase();
      const ds = dateStr || getTzToday();
      let data = null;

      try {
        if (client) {
          const res = await client.from('daily_extra_products').select('*').eq('report_date', ds).maybeSingle();
          if (res.data) {
            data = res.data;
          } else {
            // 해당 날짜 데이터가 없으면 이전 가장 최근 데이터를 찾아 목표와 누계실적을 이어받음
            const prevRes = await client.from('daily_extra_products')
              .select('*')
              .lte('report_date', ds)
              .order('report_date', { ascending: false })
              .limit(1)
              .maybeSingle();
            if (prevRes.data) {
              const p = prevRes.data;
              data = {
                report_date: ds,
                doorcam_target: p.doorcam_target != null ? p.doorcam_target : 54,
                doorcam_prev: (Number(p.doorcam_prev) || 0) + (Number(p.doorcam_today) || 0),
                doorcam_today: 0,
                safety_order_target: p.safety_order_target || 0,
                safety_order_prev: (Number(p.safety_order_prev) || 0) + (Number(p.safety_order_today) || 0),
                safety_order_today: 0,
                safety_sales_target: p.safety_sales_target || 0,
                safety_sales_prev: (Number(p.safety_sales_prev) || 0) + (Number(p.safety_sales_today) || 0),
                safety_sales_today: 0
              };
            }
          }
        }
      } catch (e) {
        console.warn('daily_extra_products fetch notice:', e);
      }

      // 로컬 스토리지에 저장된 해당 날짜 입력값 반영 (Fail-safe)
      try {
        const local = localStorage.getItem('EXTRA_PRODUCT_' + ds);
        if (local) {
          const lData = JSON.parse(local);
          data = Object.assign({}, data || {}, lData);
        }
      } catch(e) {}

      // 기본값 폴백 (북서울지사 목표 54대, 8월말 기준 누계실적 23대)
      const dcTarget = (data && data.doorcam_target != null && data.doorcam_target !== '') ? Number(data.doorcam_target) : 54;
      const dcPrev = (data && data.doorcam_prev != null && data.doorcam_prev !== '') ? Number(data.doorcam_prev) : 23;
      const dcToday = (data && data.doorcam_today != null && data.doorcam_today !== '') ? Number(data.doorcam_today) : 0;
      const dcCum = dcPrev + dcToday;

      return {
        success: true, date: ds,
        안전상품: {
          수주: { 
            목표: data ? (Number(data.safety_order_target) || 0) : 0, 
            전일누계: data ? (Number(data.safety_order_prev) || 0) : 0, 
            당일: data ? (Number(data.safety_order_today) || 0) : 0,
            누계: data ? ((Number(data.safety_order_prev) || 0) + (Number(data.safety_order_today) || 0)) : 0
          },
          매출: { 
            목표: data ? (Number(data.safety_sales_target) || 0) : 0, 
            전일누계: data ? (Number(data.safety_sales_prev) || 0) : 0, 
            당일: data ? (Number(data.safety_sales_today) || 0) : 0,
            누계: data ? ((Number(data.safety_sales_prev) || 0) + (Number(data.safety_sales_today) || 0)) : 0
          }
        },
        AI도어캠: {
          판매량: { 
            목표: dcTarget, 
            전일누계: dcPrev, 
            당일: dcToday,
            누계: dcCum
          }
        }
      };
    },

    saveExtraProductReport: async function(token, dateStr, d) {
      const client = getSupabase();
      const ds = dateStr || getTzToday();

      // 1. 기존 데이터 조회하여 필드 병합(Merge)
      let existing = null;
      try {
        if (client) {
          const { data } = await client.from('daily_extra_products').select('*').eq('report_date', ds).maybeSingle();
          existing = data;
        }
      } catch(e) {}

      const record = {
        report_date: ds,
        doorcam_target: d.AI도어캠_판매량_목표 != null ? Number(d.AI도어캠_판매량_목표) : (existing && existing.doorcam_target != null ? existing.doorcam_target : 54),
        doorcam_prev: d.AI도어캠_판매량_전일누계 != null ? Number(d.AI도어캠_판매량_전일누계) : (existing && existing.doorcam_prev != null ? existing.doorcam_prev : 23),
        doorcam_today: d.AI도어캠_판매량_당일 != null ? Number(d.AI도어캠_판매량_당일) : (existing && existing.doorcam_today != null ? existing.doorcam_today : 0),
        safety_order_target: d.안전상품_수주_목표 != null ? Number(d.안전상품_수주_목표) : (existing ? existing.safety_order_target : 0),
        safety_order_prev: d.안전상품_수주_전일누계 != null ? Number(d.안전상품_수주_전일누계) : (existing ? existing.safety_order_prev : 0),
        safety_order_today: d.안전상품_수주_당일 != null ? Number(d.안전상품_수주_당일) : (existing ? existing.safety_order_today : 0),
        safety_sales_target: d.안전상품_매출_목표 != null ? Number(d.안전상품_매출_목표) : (existing ? existing.safety_sales_target : 0),
        safety_sales_prev: d.안전상품_매출_전일누계 != null ? Number(d.안전상품_매출_전일누계) : (existing ? existing.safety_sales_prev : 0),
        safety_sales_today: d.안전상품_매출_당일 != null ? Number(d.안전상품_매출_당일) : (existing ? existing.safety_sales_today : 0),
        updated_at: new Date().toISOString()
      };

      // 2. 로컬 스토리지에 안전 백업 (Fail-safe)
      try {
        localStorage.setItem('EXTRA_PRODUCT_' + ds, JSON.stringify(record));
      } catch(e) {}

      // 3. Supabase upsert
      if (client) {
        const { error } = await client.from('daily_extra_products').upsert(record, { onConflict: 'report_date' });
        if (error) {
          console.warn('daily_extra_products upsert warning:', error);
          throw error;
        }
      }
      return Backend.getExtraProductReport(token, ds);
    },

    // 12. 영업현황 및 종합대시보드
    getSalesStatus: async function(token, yearMonth, productFilter) {
      const ym = yearMonth || getTzToday().slice(0, 7);
      const pf = productFilter || '일반알람';
      const client = getSupabase();

      // 1. 실시간 라이브 계산 수행 (스냅샷 불일치 및 401 권한오류 방지)

      // 2. 실시간 라이브 계산
      const [ordRes, canRes, prcRes, rstRes, tgtProdRes, tgtRepRes] = await Promise.all([
        client.from('daily_orders').select('*'),
        client.from('daily_cancels').select('*'),
        client.from('daily_price_changes').select('*'),
        client.from('daily_restarts').select('*'),
        client.from('sales_targets_product').select('*').eq('year_month', ym),
        client.from('sales_targets_rep').select('*').eq('year_month', ym)
      ]);

      const SALES_STATUS_PRODUCT_FILTERS = {
        '일반알람': ['알람', '블루스캔', '유지보수'],
        '알람+휴엔': ['알람', '블루스캔', '유지보수', '휴엔'],
        '정보보안': ['정보보안'],
        '디지털': ['정보보안'],
        '휴엔': ['휴엔']
      };
      const SALES_TARGET_CATEGORIES = {
        '일반알람': ['알람'],
        '알람+휴엔': ['알람', '휴엔'],
        '정보보안': ['정보보안'],
        '디지털': ['정보보안'],
        '휴엔': ['휴엔']
      };

      const filterKey = SALES_STATUS_PRODUCT_FILTERS[pf] ? pf : '일반알람';
      const allowed = SALES_STATUS_PRODUCT_FILTERS[filterKey];
      const targetCats = SALES_TARGET_CATEGORIES[filterKey] || ['알람'];

      const parts = String(ym).split('-');
      const yy = Number(parts[0]), mm = Number(parts[1]);
      const daysInMonth = new Date(yy, mm, 0).getDate();

      const orders = ordRes.data || [];
      const cancels = canRes.data || [];
      const prices = prcRes.data || [];
      const restarts = rstRes.data || [];

      const 수주Raw = new Array(daysInMonth).fill(0);
      const 개시Raw = new Array(daysInMonth).fill(0);
      const 해약Raw = new Array(daysInMonth).fill(0);
      const pricePos = new Array(daysInMonth).fill(0);
      const priceNeg = new Array(daysInMonth).fill(0);
      const 재개시Raw = new Array(daysInMonth).fill(0);

      // Orders (수주: contract_date, 개시: billing_date)
      orders.forEach(r => {
        if (String(r.gross_type) === '법인') return;
        if (allowed.indexOf(String(r.product_name)) === -1) return;
        if (r.contract_date && String(r.contract_date).slice(0, 7) === ym) {
          const d = Number(String(r.contract_date).slice(8, 10));
          if (d >= 1 && d <= daysInMonth) 수주Raw[d - 1] += Number(r.monthly_fee) || 0;
        }
        if (r.billing_date && String(r.billing_date).slice(0, 7) === ym) {
          const d = Number(String(r.billing_date).slice(8, 10));
          if (d >= 1 && d <= daysInMonth) 개시Raw[d - 1] += Number(r.monthly_fee) || 0;
        }
      });

      // Cancels (해약: confirm_date)
      cancels.forEach(r => {
        if (String(r.gross_type) === '법인') return;
        if (allowed.indexOf(String(r.product_name)) === -1) return;
        if (r.confirm_date && String(r.confirm_date).slice(0, 7) === ym) {
          const d = Number(String(r.confirm_date).slice(8, 10));
          if (d >= 1 && d <= daysInMonth) 해약Raw[d - 1] += Number(r.monthly_fee) || 0;
        }
      });

      // Price changes (인상/인하: billing_date)
      prices.forEach(r => {
        if (String(r.gross_type) === '법인') return;
        if (allowed.indexOf(String(r.product_name)) === -1) return;
        if (r.billing_date && String(r.billing_date).slice(0, 7) === ym) {
          const d = Number(String(r.billing_date).slice(8, 10));
          if (d >= 1 && d <= daysInMonth) {
            const amt = Number(r.diff_amount) || 0;
            if (amt >= 0) pricePos[d - 1] += amt; else priceNeg[d - 1] += amt;
          }
        }
      });

      // Restarts (재개시: restart_date)
      restarts.forEach(r => {
        if (String(r.gross_type) === '법인') return;
        if (allowed.indexOf(String(r.product_name)) === -1) return;
        if (r.restart_date && String(r.restart_date).slice(0, 7) === ym) {
          const d = Number(String(r.restart_date).slice(8, 10));
          if (d >= 1 && d <= daysInMonth) 재개시Raw[d - 1] += Number(r.monthly_fee) || 0;
        }
      });

      // Target calculation
      let 목수 = 0, 목개 = 0, 목유감 = 0, 계수 = 0, 계개 = 0, 계유감 = 0;
      (tgtProdRes.data || []).filter(r => targetCats.indexOf(r.product_type) !== -1).forEach(r => {
        목수 += Number(r.target_order) || 0;
        목개 += Number(r.target_start) || 0;
        목유감 += Number(r.target_cancel) || 0;
        계수 += Number(r.plan_order) || 0;
        계개 += Number(r.plan_start) || 0;
        계유감 += Number(r.plan_cancel) || 0;
      });
      const 목표유지증가 = 목개 - 목유감;
      const 계획유지증가 = 계개 - 계유감;
      const target = {
        년월: ym,
        목표_수주금액: 목수, 목표_개시금액: 목개, 목표_유지감소: 목유감, 목표_유지증가: 목표유지증가,
        계획_수주금액: 계수, 계획_개시금액: 계개, 계획_유지감소: 계유감, 계획_유지증가: 계획유지증가,
        목표대비계획비율: 목표유지증가 !== 0 ? Math.round((계획유지증가 / 목표유지증가) * 1000) / 10 : 0
      };

      const rows = [];
      let 수주누계Raw = 0, 개시누계Raw = 0, 해약누계Raw = 0, 인상누계Raw = 0, 인하누계Raw = 0, 재개시누계Raw = 0, 유지증가누적Raw = 0;

      for (let d = 1; d <= daysInMonth; d++) {
        const i = d - 1;
        const 수주당일 = 수주Raw[i] || 0, 개시당일 = 개시Raw[i] || 0, 해약당일 = 해약Raw[i] || 0;
        const 인상당일 = pricePos[i] || 0, 인하당일 = priceNeg[i] || 0, 재개시당일 = 재개시Raw[i] || 0;
        const 일유증당일 = 개시당일 - (해약당일 - 인상당일 - 인하당일 - 재개시당일);

        수주누계Raw += 수주당일;
        개시누계Raw += 개시당일;
        해약누계Raw += 해약당일;
        인상누계Raw += 인상당일;
        인하누계Raw += 인하당일;
        재개시누계Raw += 재개시당일;
        유지증가누적Raw += 일유증당일;

        const 유지감소누계Raw = 해약누계Raw - 인상누계Raw - 인하누계Raw - 재개시누계Raw;
        const 유지증가누계Raw = 유지증가누적Raw;

        const 수주당일K = Math.round(수주당일 / 1000);
        const 개시당일K = Math.round(개시당일 / 1000);
        const 해약중지당일K = Math.round(해약당일 / 1000);
        const 인상당일K = Math.round(인상당일 / 1000);
        const 인하당일K = Math.round(인하당일 / 1000);
        const 재개시당일K = Math.round(재개시당일 / 1000);
        const 일유증당일K = Math.round(일유증당일 / 1000);
        const 유지증가누계K = Math.round(유지증가누계Raw / 1000);
        const 달성률 = 목표유지증가 !== 0 ? Math.round((유지증가누계K / 목표유지증가) * 1000) / 10 : 0;

        rows.push({
          날짜: ym + '-' + String(d).padStart(2, '0'),
          수주: 수주당일K, 개시: 개시당일K, 해약중지: 해약중지당일K,
          인상: 인상당일K, 인하: 인하당일K, 재개시: 재개시당일K,
          일유증: 일유증당일K, 유지증가: 유지증가누계K, 달성률: 달성률,
          누계수주: Math.round(수주누계Raw / 1000),
          누계개시: Math.round(개시누계Raw / 1000),
          누계해약중지: Math.round(해약누계Raw / 1000),
          누계인상: Math.round(인상누계Raw / 1000),
          누계인하: Math.round(인하누계Raw / 1000),
          누계재개시: Math.round(재개시누계Raw / 1000),
          누계유지감소: Math.round(유지감소누계Raw / 1000),
          누계유지증가: 유지증가누계K
        });
      }

      const last = rows[rows.length - 1] || {};
      const actual = {
        수주: last.누계수주 || 0,
        개시: last.누계개시 || 0,
        유지감소: last.누계유지감소 || 0,
        유지증가: last.누계유지증가 || 0
      };

      const reps = ['최영국', '이수열', '박광춘', '정문재', '임영민'];
      const repActualsRaw = {};
      reps.forEach(r => { repActualsRaw[r] = { 수주: 0, 개시: 0, 해약: 0, 인상: 0, 인하: 0, 재개시: 0 }; });

      orders.forEach(r => {
        if (String(r.gross_type) === '법인') return;
        if (allowed.indexOf(String(r.product_name)) === -1) return;
        const rep = String(r.rep_name || '').trim();
        if (!repActualsRaw[rep]) repActualsRaw[rep] = { 수주: 0, 개시: 0, 해약: 0, 인상: 0, 인하: 0, 재개시: 0 };
        if (r.contract_date && String(r.contract_date).slice(0, 7) === ym) repActualsRaw[rep].수주 += Number(r.monthly_fee) || 0;
        if (r.billing_date && String(r.billing_date).slice(0, 7) === ym) repActualsRaw[rep].개시 += Number(r.monthly_fee) || 0;
      });

      cancels.forEach(r => {
        if (String(r.gross_type) === '법인') return;
        if (allowed.indexOf(String(r.product_name)) === -1) return;
        const rep = String(r.rep_name || '').trim();
        if (!repActualsRaw[rep]) repActualsRaw[rep] = { 수주: 0, 개시: 0, 해약: 0, 인상: 0, 인하: 0, 재개시: 0 };
        if (r.confirm_date && String(r.confirm_date).slice(0, 7) === ym) repActualsRaw[rep].해약 += Number(r.monthly_fee) || 0;
      });

      prices.forEach(r => {
        if (String(r.gross_type) === '법인') return;
        if (allowed.indexOf(String(r.product_name)) === -1) return;
        const rep = String(r.rep_name || '').trim();
        if (!repActualsRaw[rep]) repActualsRaw[rep] = { 수주: 0, 개시: 0, 해약: 0, 인상: 0, 인하: 0, 재개시: 0 };
        if (r.billing_date && String(r.billing_date).slice(0, 7) === ym) {
          const amt = Number(r.diff_amount) || 0;
          if (amt >= 0) repActualsRaw[rep].인상 += amt; else repActualsRaw[rep].인하 += amt;
        }
      });

      restarts.forEach(r => {
        if (String(r.gross_type) === '법인') return;
        if (allowed.indexOf(String(r.product_name)) === -1) return;
        const rep = String(r.rep_name || '').trim();
        if (!repActualsRaw[rep]) repActualsRaw[rep] = { 수주: 0, 개시: 0, 해약: 0, 인상: 0, 인하: 0, 재개시: 0 };
        if (r.restart_date && String(r.restart_date).slice(0, 7) === ym) repActualsRaw[rep].재개시 += Number(r.monthly_fee) || 0;
      });

      const repMetrics = {};
      Object.keys(repActualsRaw).forEach(rep => {
        const d = repActualsRaw[rep];
        const 유지감소Raw = d.해약 - d.인상 - d.인하 - d.재개시;
        const 유지증가Raw = d.개시 - 유지감소Raw;
        repMetrics[rep] = {
          수주: Math.round(d.수주 / 1000),
          개시: Math.round(d.개시 / 1000),
          유지감소: Math.round(유지감소Raw / 1000),
          유지증가: Math.round(유지증가Raw / 1000)
        };
      });

      const repTargets = {};
      const repTargetRows = tgtRepRes.data || [];
      const hasRepTargets = repTargetRows.length > 0;
      reps.forEach(rep => {
        let rOrd = 0, rStart = 0, rCancel = 0;
        if (hasRepTargets) {
          repTargetRows.filter(r => r.rep_name === rep && targetCats.indexOf(r.product_type) !== -1).forEach(r => {
            rOrd += Number(r.target_order) || 0;
            rStart += Number(r.target_start) || 0;
            rCancel += Number(r.target_cancel) || 0;
          });
        } else {
          rOrd = Math.round(target.목표_수주금액 / reps.length);
          rStart = Math.round(target.목표_개시금액 / reps.length);
          rCancel = Math.round(target.목표_유지감소 / reps.length);
        }
        repTargets[rep] = {
          목표_수주금액: rOrd,
          목표_개시금액: rStart,
          목표_유지감소: rCancel,
          목표_유지증가: rStart - rCancel
        };
      });

      const result = {
        success: true,
        yearMonth: ym,
        target: target,
        actual: actual,
        rows: rows,
        repMetrics: repMetrics,
        repTargets: repTargets
      };

      // 라이브 결과 반환 (불필요한 스냅샷 쓰기 제거)

      return result;
    },

    simulateSalesStatus: async function(token, yearMonth, productFilter, overrides) {
      const res = await Backend.getSalesStatus(token, yearMonth, productFilter);
      return Object.assign({}, res, { simulated: true });
    },

    refreshSalesStatusSnapshot: async function(token, yearMonth, productFilter) {
      const ym = yearMonth || getTzToday().slice(0, 7);
      const pf = productFilter || '일반알람';
      const client = getSupabase();
      // 라이브 재조회
      return Backend.getSalesStatus(token, ym, pf);
    },

    refreshSalesStatusSnapshotsForMonths: async function(token, months) {
      return { success: true };
    },

    getDashboardBundle: async function(token, yearMonth, category) {
      const ym = yearMonth || getTzToday().slice(0, 7);
      const cat = category || '일반알람';
      const statusRes = await Backend.getSalesStatus(token, ym, cat);

      const HOLIDAYS = new Set([
        '2026-01-01','2026-02-16','2026-02-17','2026-02-18','2026-03-01','2026-03-02',
        '2026-05-05','2026-05-08','2026-06-06','2026-08-15','2026-08-17',
        '2026-09-24','2026-09-25','2026-09-26','2026-09-27','2026-10-03','2026-10-05','2026-10-09','2026-12-25',
        '2027-01-01','2027-02-06','2027-02-07','2027-02-08','2027-02-09','2027-03-01',
        '2027-05-05','2027-05-13','2027-06-06','2027-08-15','2027-08-16',
        '2027-09-14','2027-09-15','2027-09-16','2027-10-03','2027-10-04','2027-10-09','2027-10-11','2027-12-25','2027-12-27'
      ]);

      const parts = String(ym).split('-');
      const yy = Number(parts[0]), mm = Number(parts[1]);
      const daysInMonth = new Date(yy, mm, 0).getDate();
      const dNow = new Date();
      const todayYm = `${dNow.getFullYear()}-${String(dNow.getMonth() + 1).padStart(2, '0')}`;
      const todayDate = dNow.getDate();

      let totalWorking = 0, elapsedWorking = 0;
      for (let d = 1; d <= daysInMonth; d++) {
        const dateObj = new Date(yy, mm - 1, d);
        const dow = dateObj.getDay();
        const ds = `${yy}-${String(mm).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const isWorking = dow !== 0 && dow !== 6 && !HOLIDAYS.has(ds);
        if (isWorking) {
          totalWorking++;
          if (ym < todayYm || (ym === todayYm && d <= todayDate)) elapsedWorking++;
        }
      }
      if (ym > todayYm) elapsedWorking = 0;
      const working = {
        totalWorkingDays: totalWorking,
        elapsedWorkingDays: elapsedWorking,
        ratio: totalWorking ? Math.round((elapsedWorking / totalWorking) * 1000) / 10 : 0
      };

      const client = getSupabase();
      const [ordRes, canRes, prcRes] = await Promise.all([
        client.from('daily_orders').select('*'),
        client.from('daily_cancels').select('*'),
        client.from('daily_price_changes').select('*')
      ]);

      const today = getTzToday();
      const SALES_STATUS_PRODUCT_FILTERS = {
        '일반알람': ['알람', '블루스캔', '유지보수'],
        '알람+휴엔': ['알람', '블루스캔', '유지보수', '휴엔'],
        '정보보안': ['정보보안'],
        '디지털': ['정보보안'],
        '휴엔': ['휴엔']
      };
      const filterKey = SALES_STATUS_PRODUCT_FILTERS[cat] ? cat : '일반알람';
      const allowed = SALES_STATUS_PRODUCT_FILTERS[filterKey] || ['알람', '블루스캔', '유지보수'];

      function aggregateComp(rows, keyFn, amtFn) {
        const map = {};
        let totalAmt = 0, totalCnt = 0;
        rows.forEach(r => {
          const k = keyFn(r) || '기타';
          const a = amtFn ? (Number(amtFn(r)) || 0) : 0;
          if (!map[k]) map[k] = { name: k, count: 0, amount: 0 };
          map[k].count++; map[k].amount += a;
          totalCnt++; totalAmt += a;
        });
        const list = Object.keys(map).map(k => map[k]);
        list.forEach(it => {
          it.pctCount = totalCnt ? Math.round((it.count / totalCnt) * 100) : 0;
          it.pctAmount = totalAmt ? Math.round((it.amount / totalAmt) * 100) : 0;
        });
        list.sort((a, b) => b.amount - a.amount || b.count - a.count);
        return { list: list, totalCount: totalCnt, totalAmount: totalAmt };
      }

      function daysBetween(a, b) {
        if (!a || !b || !/^\d{4}-\d{2}-\d{2}/.test(String(a)) || !/^\d{4}-\d{2}-\d{2}/.test(String(b))) return null;
        const da = new Date(String(a).slice(0, 10)), db = new Date(String(b).slice(0, 10));
        return Math.round((db - da) / 86400000);
      }

      function gapBucket(days) {
        if (days === null || days === undefined || isNaN(days)) return '미정';
        if (days <= 3) return '0~3일';
        if (days <= 7) return '4~7일';
        if (days <= 14) return '8~14일';
        if (days <= 30) return '15~30일';
        return '31일 이상';
      }

      function bucketize(daysArr) {
        const buckets = {};
        daysArr.forEach(d => { const b = gapBucket(d); buckets[b] = (buckets[b] || 0) + 1; });
        const order = ['0~3일', '4~7일', '8~14일', '15~30일', '31일 이상', '미정'];
        const total = daysArr.length;
        return order.filter(b => buckets[b]).map(b => ({ label: b, count: buckets[b], pct: total ? Math.round((buckets[b] / total) * 100) : 0 }));
      }

      function avgOf(arr) { return arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : 0; }

      // Order analytics
      const filteredOrders = (ordRes.data || [])
        .filter(r => {
          const isOrderInMonth = (r.order_ym === ym || (r.contract_date && String(r.contract_date).slice(0, 7) === ym));
          const isStartInMonth = (r.start_ym === ym || (r.start_date && String(r.start_date).slice(0, 7) === ym) || (r.billing_date && String(r.billing_date).slice(0, 7) === ym));
          const isOrderBeforeToday = (!r.contract_date || String(r.contract_date).slice(0, 10) <= today);
          const isStartBeforeToday = (!r.start_date || String(r.start_date).slice(0, 10) <= today);
          const isBillingBeforeToday = (!r.billing_date || String(r.billing_date).slice(0, 10) <= today);
          return (isOrderInMonth && isOrderBeforeToday) || (isStartInMonth && (isStartBeforeToday || isBillingBeforeToday));
        })
        .filter(r => allowed.indexOf(String(r.product_name)) !== -1)
        .filter(r => String(r.gross_type) !== '법인');

      function buildOrderFor(list) {
        const motive = aggregateComp(list, r => r.sales_motive || '기타', r => Number(r.monthly_fee) || 0);
        const product = aggregateComp(list, r => r.product_name || '기타', r => Number(r.monthly_fee) || 0);
        const amounts = list.map(r => Number(r.monthly_fee) || 0);
        const total = amounts.reduce((a, b) => a + b, 0);
        const avg = amounts.length ? Math.round(total / amounts.length) : 0;
        const gapStart = list.map(r => daysBetween(r.contract_date, r.start_date)).filter(v => v !== null);
        const gapBase = list.map(r => daysBetween(r.contract_date, r.billing_date)).filter(v => v !== null);
        const orderedThisMonth = list.filter(r => r.contract_date && r.contract_date.slice(0, 7) === ym);
        const startedSameMonth = orderedThisMonth.filter(r => r.billing_date && r.billing_date.slice(0, 7) === ym && r.billing_date <= today);
        const monthlyStartRate = orderedThisMonth.length ? Math.round((startedSameMonth.length / orderedThisMonth.length) * 100) : 0;
        return {
          count: list.length, amount: total, avgAmount: avg,
          byMotive: motive.list, byProduct: product.list,
          gapStart: { avg: avgOf(gapStart), buckets: bucketize(gapStart) },
          gapBase: { avg: avgOf(gapBase), buckets: bucketize(gapBase) },
          monthlyOrderCount: orderedThisMonth.length, monthlyStartedCount: startedSameMonth.length, monthlyStartRate: monthlyStartRate
        };
      }

      const orderOverall = buildOrderFor(filteredOrders);
      const reps = ['최영국', '이수열', '박광춘', '정문재', '임영민'];
      const orderByRep = {};
      reps.forEach(rep => { orderByRep[rep] = buildOrderFor(filteredOrders.filter(r => String(r.rep_name || '').trim() === rep)); });

      // Cancel analytics
      const filteredCancels = (canRes.data || [])
        .filter(r => r.confirm_date && r.confirm_date.slice(0, 7) === ym && r.confirm_date <= today)
        .filter(r => allowed.indexOf(String(r.product_name)) !== -1)
        .filter(r => String(r.gross_type) !== '법인');

      function buildCancelFor(list) {
        const reason = aggregateComp(list, r => r.cancel_type || '기타', r => Number(r.monthly_fee) || 0);
        const product = aggregateComp(list, r => r.product_name || '기타', r => Number(r.monthly_fee) || 0);
        const amounts = list.map(r => Number(r.monthly_fee) || 0);
        const total = amounts.reduce((a, b) => a + b, 0);
        const avg = amounts.length ? Math.round(total / amounts.length) : 0;
        return { count: list.length, amount: total, avgAmount: avg, byReason: reason.list, byProduct: product.list };
      }
      const cancelOverall = buildCancelFor(filteredCancels);
      const cancelByRep = {};
      reps.forEach(rep => { cancelByRep[rep] = buildCancelFor(filteredCancels.filter(r => String(r.rep_name || '').trim() === rep)); });

      // Price analytics
      function buildPriceFor(changeType) {
        const filtered = (prcRes.data || [])
          .filter(r => r.billing_date && r.billing_date.slice(0, 7) === ym && r.billing_date <= today)
          .filter(r => changeType === '인상' ? (Number(r.diff_amount) > 0) : (Number(r.diff_amount) < 0))
          .filter(r => String(r.gross_type) !== '법인');
        const amounts = filtered.map(r => Math.abs(Number(r.diff_amount) || 0));
        const total = amounts.reduce((a, b) => a + b, 0);
        const avg = amounts.length ? Math.round(total / amounts.length) : 0;
        const reason = aggregateComp(filtered, r => r.reason || '기타', r => Math.abs(Number(r.diff_amount) || 0));
        const product = aggregateComp(filtered, r => r.product_name || '기타', r => Math.abs(Number(r.diff_amount) || 0));
        const byRep = aggregateComp(filtered, r => r.rep_name || '기타', r => Math.abs(Number(r.diff_amount) || 0));
        const byReceiver = aggregateComp(filtered, r => r.receiver_name || '기타', r => Math.abs(Number(r.diff_amount) || 0));
        return { overall: { count: filtered.length, amount: total, avgAmount: avg }, byRep: byRep.list, byReceiver: byReceiver.list, byReason: reason.list, byProduct: product.list };
      }

      const priceUpPayload = buildPriceFor('인상');
      const priceDownPayload = buildPriceFor('인하');

      return {
        success: true,
        status: statusRes,
        working: { success: true, info: working },
        order: { success: true, yearMonth: ym, overall: orderOverall, byRep: orderByRep },
        cancel: { success: true, yearMonth: ym, overall: cancelOverall, byRep: cancelByRep },
        priceUp: Object.assign({ success: true, yearMonth: ym }, priceUpPayload),
        priceDown: Object.assign({ success: true, yearMonth: ym }, priceDownPayload)
      };
    },

    // 13. 설정 및 기타
    getEditableLists: async function(token) {
      const lists = { '영업동기': [], '해약유형': [], '인상인하사유': [], '영업컨설턴트': [], '상품일보_담당자': [] };
      const defaults = {};

      // 1. Try local storage first
      try {
        const local = localStorage.getItem('S1_EDITABLE_SETTINGS');
        if (local) {
          const parsed = JSON.parse(local);
          if (parsed && parsed.lists) {
            return { success: true, lists: parsed.lists, defaults: parsed.defaults || {} };
          }
        }
      } catch(e) {}

      // 2. Try Supabase
      try {
        const client = getSupabase();
        if (client) {
          const { data, error } = await client.from('editable_settings').select('*').order('sort_order', { ascending: true });
          if (!error && data) {
            data.forEach(r => {
              if (lists[r.category]) {
                lists[r.category].push(r.item_value);
                if (r.is_default) defaults[r.category] = r.item_value;
              }
            });
          }
        }
      } catch(e) {}

      // 기본값 폴백
      if (!lists['영업동기'].length) lists['영업동기'] = ['개척', '콜센터', '사내소개', '고객소개', '대리점', '관내이전', '관외이전', '그로스', '기타'];
      if (!lists['해약유형'].length) lists['해약유형'] = ['폐업', '타사전환', '관외이전', '관내이전', '통합', '공사', '경비절감', '고객사망', '중지'];
      if (!lists['인상인하사유'].length) lists['인상인하사유'] = ['변추가인상', '순수인상', '서비스추가', '경비구역축소', '약정기간', '해약방어인하', '법인인하'];
      if (!lists['영업컨설턴트'].length) lists['영업컨설턴트'] = ['최영국', '이수열', '박광춘', '정문재', '임영민'];
      if (!lists['상품일보_담당자'].length) lists['상품일보_담당자'] = ['박정훈', '박광모', '김상훈', '최영국', '이수열', '박광춘', '정문재', '임영민'];

      return { success: true, lists: lists, defaults: defaults };
    },

    saveEditableListsBulk: async function(token, payload) {
      const lists = {};
      const defaults = {};

      Object.keys(payload || {}).forEach(cat => {
        const entry = payload[cat] || {};
        lists[cat] = entry.items || [];
        if (entry.defaultValue) defaults[cat] = entry.defaultValue;
      });

      // 1. Save to localStorage immediately
      try {
        localStorage.setItem('S1_EDITABLE_SETTINGS', JSON.stringify({ lists: lists, defaults: defaults }));
      } catch(e) {}

      // 2. Try Supabase upsert safely
      try {
        const client = getSupabase();
        if (client) {
          const rows = [];
          Object.keys(payload || {}).forEach(cat => {
            const entry = payload[cat] || {};
            (entry.items || []).forEach((val, idx) => {
              rows.push({
                category: cat,
                item_value: val,
                is_default: (val === entry.defaultValue),
                sort_order: idx + 1
              });
            });
          });
          if (rows.length) {
            const { error } = await client.from('editable_settings').upsert(rows, { onConflict: 'category,item_value' });
            if (error) console.warn('Supabase editable_settings sync notice (saved locally):', error.message || error);
          }
        }
      } catch(e) {
        console.warn('Supabase sync skipped, saved locally:', e);
      }

      return { success: true, lists: lists, defaults: defaults };
    },

    getTaPortalUrl: async function(token) {
      const client = getSupabase();
      const { data } = await client.from('system_settings').select('setting_value').eq('setting_key', 'TA_PORTAL_URL').maybeSingle();
      const u = (data && data.setting_value && !data.setting_value.includes('script.google.com')) ? data.setting_value : 'https://jhsim2545.github.io/TA-Manager/';
      return { success: true, url: u };
    },

    saveTaPortalUrl: async function(token, url) {
      const client = getSupabase();
      await client.from('system_settings').upsert({ setting_key: 'TA_PORTAL_URL', setting_value: url });
      return { success: true };
    },
    getIntroPortalUrl: async function(token) {
      const client = getSupabase();
      const { data } = await client.from('system_settings').select('setting_value').eq('setting_key', 'INTRO_PORTAL_URL').maybeSingle();
      const u = (data && data.setting_value && !data.setting_value.includes('script.google.com')) ? data.setting_value : 'https://jhsim2545.github.io/DailySales/Lead-app_index.html';
      return { success: true, url: u };
    },

    saveIntroPortalUrl: async function(token, url) {
      const client = getSupabase();
      await client.from('system_settings').upsert({ setting_key: 'INTRO_PORTAL_URL', setting_value: url });
      return { success: true };
    },


    // 14. 접수함 큐
    submitAiReportMessage: async function(token, text) {
      const client = getSupabase();
      const sess = getSession_();
      const { error } = await client.from('inbox_ai_reports').insert([{
        submitted_by: sess ? sess.name : '사용자',
        raw_text: text,
        status: '대기'
      }]);
      if (error) throw error;
      return { success: true };
    },

    listPendingAiReportMessages: async function(token) {
      const client = getSupabase();
      const { data, error } = await client.from('inbox_ai_reports').select('*').eq('status', '대기').order('submitted_at', { ascending: false });
      if (error) return { success: true, items: [] };
      const items = (data || []).map(r => ({
        id: r.id,
        submittedAt: r.submitted_at ? r.submitted_at.slice(0, 16).replace('T', ' ') : '',
        submittedBy: r.submitted_by,
        text: r.raw_text,
        source: r.source || '수동'
      }));
      return { success: true, items: items };
    },

    markAiReportMessageProcessed: async function(token, id, resultType) {
      const client = getSupabase();
      const sess = getSession_();
      await client.from('inbox_ai_reports').update({
        status: '처리완료',
        processed_at: new Date().toISOString(),
        processed_by: sess ? sess.name : '마스터',
        registered_type: resultType
      }).eq('id', id);
      return { success: true };
    },

    dismissAiReportMessage: async function(token, id) {
      const client = getSupabase();
      const sess = getSession_();
      await client.from('inbox_ai_reports').update({
        status: '무시됨',
        processed_at: new Date().toISOString(),
        processed_by: sess ? sess.name : '마스터'
      }).eq('id', id);
      return { success: true };
    },

    submitGaJungjiMessage: async function(token, text) {
      const client = getSupabase();
      const sess = getSession_();
      const { error } = await client.from('inbox_gajungji').insert([{
        submitted_by: sess ? sess.name : 'CS근무자',
        raw_text: text,
        status: '대기'
      }]);
      if (error) throw error;
      return { success: true };
    },

    listPendingGaJungjiMessages: async function(token) {
      const client = getSupabase();
      const { data, error } = await client.from('inbox_gajungji').select('*').eq('status', '대기').order('submitted_at', { ascending: false });
      if (error) return { success: true, items: [] };
      const items = (data || []).map(r => ({
        id: r.id,
        submittedAt: r.submitted_at ? r.submitted_at.slice(0, 16).replace('T', ' ') : '',
        submittedBy: r.submitted_by,
        text: r.raw_text
      }));
      return { success: true, items: items };
    },

    markGaJungjiMessageProcessed: async function(token, id, resultType) {
      const client = getSupabase();
      const sess = getSession_();
      await client.from('inbox_gajungji').update({
        status: '처리완료',
        processed_at: new Date().toISOString(),
        processed_by: sess ? sess.name : '마스터',
        registered_type: resultType
      }).eq('id', id);
      return { success: true };
    },

    dismissGaJungjiMessage: async function(token, id) {
      const client = getSupabase();
      const sess = getSession_();
      await client.from('inbox_gajungji').update({
        status: '무시됨',
        processed_at: new Date().toISOString(),
        processed_by: sess ? sess.name : '마스터'
      }).eq('id', id);
      return { success: true };
    },

    // 15. 사업팀 데이터
    getLatestBizTeamData: async function(token, productType) {
      const client = getSupabase();
      const pt = productType || '일반알람';
      const { data } = await client.from('biz_team_data').select('*').eq('product_type', pt).order('report_date', { ascending: false }).limit(1).maybeSingle();
      if (!data) return { success: true, found: false };
      let branches = data.branches_json || [];
      if (typeof branches === 'string') {
        try { branches = JSON.parse(branches); } catch(e){ branches = []; }
      }
      let rows = data.rows_json || [];
      if (typeof rows === 'string') {
        try { rows = JSON.parse(rows); } catch(e){ rows = []; }
      }
      return {
        success: true, found: true,
        date: data.report_date,
        productType: data.product_type,
        branches: branches,
        rows: rows,
        registeredAt: data.created_at ? data.created_at.slice(0, 16).replace('T', ' ') : '',
        registeredBy: data.registered_by || ''
      };
    },

    getBizTeamDataNearestOnOrBefore: async function(token, dateStr, productType) {
      const client = getSupabase();
      const pt = productType || '일반알람';
      const { data } = await client.from('biz_team_data').select('*').eq('product_type', pt).lte('report_date', dateStr).order('report_date', { ascending: false }).limit(1).maybeSingle();
      if (!data) return { success: true, found: false };
      let branches = data.branches_json || [];
      if (typeof branches === 'string') {
        try { branches = JSON.parse(branches); } catch(e){ branches = []; }
      }
      let rows = data.rows_json || [];
      if (typeof rows === 'string') {
        try { rows = JSON.parse(rows); } catch(e){ rows = []; }
      }
      return {
        success: true, found: true,
        date: data.report_date,
        productType: data.product_type,
        branches: branches,
        rows: rows,
        registeredAt: data.created_at ? data.created_at.slice(0, 16).replace('T', ' ') : '',
        registeredBy: data.registered_by || ''
      };
    },

    getBizTeamDailyData: async function(token, dateStr, productType) {
      const client = getSupabase();
      const pt = productType || '일반알람';
      const { data } = await client.from('biz_team_data').select('*').eq('report_date', dateStr).eq('product_type', pt).maybeSingle();
      if (!data) return { success: true, found: false };
      let branches = data.branches_json || [];
      if (typeof branches === 'string') {
        try { branches = JSON.parse(branches); } catch(e){ branches = []; }
      }
      let rows = data.rows_json || [];
      if (typeof rows === 'string') {
        try { rows = JSON.parse(rows); } catch(e){ rows = []; }
      }
      return {
        success: true, found: true,
        branches: branches,
        rows: rows,
        rawText: data.raw_text || '',
        registeredAt: data.created_at ? data.created_at.slice(0, 16).replace('T', ' ') : '',
        registeredBy: data.registered_by || '',
        productType: data.product_type
      };
    },

    saveBizTeamDailyData: async function(token, dateStr, branchesJson, rowsJson, rawText, productType) {
      const client = getSupabase();
      const sess = getSession_();
      const pt = productType || '일반알람';
      let bJson = branchesJson;
      if (typeof branchesJson === 'string') {
        try { bJson = JSON.parse(branchesJson); } catch(e){ bJson = []; }
      }
      let rJson = rowsJson;
      if (typeof rowsJson === 'string') {
        try { rJson = JSON.parse(rowsJson); } catch(e){ rJson = []; }
      }

      const record = {
        report_date: dateStr,
        product_type: pt,
        registered_by: sess ? sess.name : '지사장',
        branches_json: bJson,
        rows_json: rJson,
        raw_text: rawText || '',
        created_at: new Date().toISOString()
      };
      const { error } = await client.from('biz_team_data').upsert(record, { onConflict: 'report_date,product_type' });
      if (error) throw error;
      return { success: true };
    },

    // 16. 세션 및 일반 (실시간 생존신호 및 세션 연장 기록)
    pingSession: async function(token) {
      try {
        const client = getSupabase();
        if (!client) return { success: true };
        const sess = getSession_();
        if (!sess || !sess.phone) return { success: true };
        const phone = String(sess.phone).trim();
        const dev = (typeof detectDeviceInfo_ === 'function') ? detectDeviceInfo_() : { browser:'Chrome', deviceType:'PC' };
        const key = 'HEARTBEAT_' + phone;
        const payload = {
          phone: phone,
          name: sess.name || '',
          role: sess.role || '',
          browser: dev.browser || '기타',
          device: dev.deviceType || 'PC',
          ping_at: Date.now(),
          last_activity: (typeof LAST_RAW_ACTIVITY_AT_ !== 'undefined' ? LAST_RAW_ACTIVITY_AT_ : Date.now()),
          online: true
        };
        client.from('system_settings').upsert({
          setting_key: key,
          setting_value: JSON.stringify(payload)
        }).then(() => {});
      } catch(e) {
        console.warn('[pingSession] heartbeat error:', e);
      }
      return { success: true };
    },

    extendSession: async function(token) {
      try {
        const client = getSupabase();
        if (!client) return { success: true };
        const sess = getSession_();
        if (!sess || !sess.phone) return { success: true };
        const phone = String(sess.phone).trim();
        const dev = (typeof detectDeviceInfo_ === 'function') ? detectDeviceInfo_() : { browser:'Chrome', deviceType:'PC' };
        const key = 'HEARTBEAT_' + phone;
        const payload = {
          phone: phone,
          name: sess.name || '',
          role: sess.role || '',
          browser: dev.browser || '기타',
          device: dev.deviceType || 'PC',
          ping_at: Date.now(),
          last_activity: Date.now(),
          online: true
        };
        client.from('system_settings').upsert({
          setting_key: key,
          setting_value: JSON.stringify(payload)
        }).then(() => {});
      } catch(e) {}
      return { success: true };
    },
    getWebAppUrl: async function() { return window.location.href; },

        // ===================== 문장 분석 엔진 (영업보고 & 가중지보고 완벽 구현) =====================
    parseSalesReportText: async function(token, text, reporterName, reportDateOverride) {
      const raw0 = String(text || '').trim();
      if (!raw0) return { success: false, error: '분석할 내용이 없습니다.' };
      try {
        const today = (/^\d{4}-\d{2}-\d{2}$/.test(String(reportDateOverride || ''))) ? reportDateOverride : ruleParseToday_();
        const t = raw0.replace(/\s+/g, ' ');
        const tNoParens = t.replace(/\([^)]*\)/g, ' ');
        const repList = ['최영국', '이수열', '박광춘', '정문재', '임영민'];
        const motiveList = ['개척', '콜센터', '사내소개', '고객소개', '대리점', '관내이전', '관외이전', '그로스', '기타'];
        const cancelTypeList = ['폐업', '타사전환', '관외이전', '관내이전', '통합', '공사', '경비절감', '고객사망', '중지'];
        const priceReasonList = ['변추가인상', '순수인상', '서비스추가', '경비구역축소', '약정기간', '해약방어인하', '법인인하'];

        let type = null;
        if (/수주\s*보고|신규\s*보고/.test(t)) type = 'order_start';
        else if (/해약\s*보고|중지\s*보고/.test(t)) type = 'cancel';
        else if (/인상\s*보고|인하\s*보고|인상인하\s*보고/.test(t)) type = 'price_change';
        if (!type) {
          if (/해약|중지|폐업|철수/.test(t)) type = 'cancel';
          else if (/인상|인하/.test(t)) type = 'price_change';
          else type = 'order_start';
        }
        if (type === 'cancel' && /재개시/.test(t)) type = 'restart';

        const contractNoM = tNoParens.match(/N\d{7,8}/);
        const contractNo = contractNoM ? contractNoM[0] : 'N';
        const contractLineCompanyName = ruleParseCompanyNameByContractLine_(raw0);
        const lineCompanyName = ruleParseGuessCompanyFromLines_(raw0, motiveList);
        const companyName = contractLineCompanyName || lineCompanyName || ruleParseFindCompanyName_(t) || '미확인';

        const cleanSender = String(reporterName || '').trim();
        const textRep = ruleParseFindFromList_(t, repList);
        let rep = '최영국';
        if (textRep) {
          rep = textRep;
        } else if (repList.indexOf(cleanSender) !== -1) {
          rep = cleanSender;
        } else {
          rep = '최영국';
        }
        const product = ruleParseFindProduct_(t);
        const car = ruleParseFindCar_(t) || '127';
        const gross = /법인/.test(t) ? '법인' : '일반';
        const amount = ruleParseFindAmount_(t);

        const AI_REPORT_LABEL_STOP_ = '(?=\\s*(?:기산일|접수일|해약일자|해약일|해약|중지일자|중지일|영업|인상자|인하자|접수자|인상금액|인하금액|사유|상호명?|공사담당|공사자|재개시일|재개시|비고|참고)\\s*[:：]|$)';
        const 사유Label = t.match(new RegExp('사유\\s*[:：]\\s*([\\s\\S]+?)' + AI_REPORT_LABEL_STOP_));
        const 사유LabelText = 사유Label ? 사유Label[1].trim() : '';
        const 비고Label = t.match(new RegExp('(?:비고|참고)\\s*[:：]\\s*([\\s\\S]+?)' + AI_REPORT_LABEL_STOP_));
        const 비고LabelText = 비고Label ? 비고Label[1].trim() : '';

        let fields = {};
        if (type === 'order_start') {
          const 보고일 = today;
          const 계약일 = today;
          const usedDateIdx_ = [];
          // 개시일자: 메시지에 있는 개시날짜(개시일:9/16 등)를 그대로 개시일에 반영
          const 개시Info = ruleParseKeywordDateInfo_(t, ['개시일', '개시', '공사일', '공사'], today, usedDateIdx_);
          // 기산일: 메시지에 별도로 '기산', '확정', '반영' 날짜가 있다면 그 날짜로 하고, 없다면 개시일과 동일한 날짜로 디폴트 세팅
          const 기산Explicit = ruleParseKeywordDate_(t, ['기산일', '기산', '확정일', '확정', '반영일', '반영'], today, usedDateIdx_);
          
          let 개시일 = 개시Info ? 개시Info.date : 계약일;
          let 기산일 = 기산Explicit ? 기산Explicit : 개시일;

          fields = {
            계약번호: contractNo, 계약처명: companyName,
            영업담당: rep, 영업동기: ruleParseFindFromList_(t, motiveList) || '개척',
            담당차량: car, 보고일: 보고일, 계약일: 계약일, 개시일: 개시일, 기산일: 기산일,
            용역료: amount !== null ? String(amount) : '',
            상품: product, 그로스: gross, 유형: '자동등록', 비고: 비고LabelText
          };
        } else if (type === 'cancel') {
          let 해약유형 = (사유LabelText && cancelTypeList.indexOf(사유LabelText) !== -1) ? 사유LabelText : ruleParseFindFromListStandalone_(t, cancelTypeList) || '폐업';
          const 사유Text = (사유LabelText && 사유LabelText !== 해약유형) ? 사유LabelText : raw0;
          const 확정일 = ruleParseKeywordDate_(t, ['중지일', '해약일자', '해약일', '확정', '해약'], today, []) || today;
          const 접수일 = ruleParseKeywordDate_(t, ['접수'], today, []) || today;
          fields = {
            계약번호: contractNo, 계약처명: companyName,
            영업담당: rep, 담당차량: car,
            접수일: 접수일, 확정일: 확정일,
            용역료: amount !== null ? String(amount) : '',
            상품: product, 그로스: gross,
            해약유형: 해약유형,
            유형: '자동등록', 사유: 사유Text
          };
        } else if (type === 'restart') {
          const 재개시일 = ruleParseKeywordDate_(t, ['재개시일', '재개시'], today, []) || today;
          const 중지일 = ruleParseKeywordDate_(t, ['중지일', '중지'], today, []) || '';
          const 공사담당Label = t.match(new RegExp('(?:공사담당|공사자)\\s*[:：]\\s*([^\\n,，]+?)' + AI_REPORT_LABEL_STOP_));
          const 공사담당 = 공사담당Label ? 공사담당Label[1].trim().slice(0, 10) : '';
          fields = {
            현상태: '재개시', 계약번호: contractNo, 계약처명: companyName,
            영업담당: rep, 담당차량: car, 재개시일: 재개시일,
            용역료: amount !== null ? String(amount) : '',
            중지일: 중지일, 공사담당: 공사담당,
            상품: product, 그로스: gross, 비고: 비고LabelText
          };
        } else if (type === 'price_change') {
          const arrow = ruleParsePriceArrow_(t);
          const isDown = /인하/.test(t) && !/인상/.test(t);
          const 금액val = arrow ? arrow.delta : (amount !== null ? (isDown ? -amount : amount) : null);
          const 現용역료val = arrow ? arrow.before : '';
          const 접수자Label = t.match(new RegExp('(?:인상자|인하자|접수자)\\s*[:：]\\s*([^\\n,，]+?)' + AI_REPORT_LABEL_STOP_));
          const 접수자 = 접수자Label ? 접수자Label[1].trim() : (sess ? sess.name : '담당자');
          const 사유후보Text = 사유LabelText || t;
          const 사유 = ruleParseFindFromListLoose_(사유후보Text, priceReasonList) || 사유LabelText || '변추가인상';
          const 기산일 = ruleParseKeywordDate_(t, ['기산일', '기산', '반영'], today, []) || today;
          const 접수일 = ruleParseKeywordDate_(t, ['접수일', '접수'], today, []) || today;
          fields = {
            계약번호: contractNo, 계약처명: companyName,
            영업담당: rep, 접수자: 접수자, 담당차량: car,
            접수일: 접수일, 기산일: 기산일,
            금액: 금액val !== null ? String(금액val) : '',
            現용역료: 現용역료val !== '' ? String(現용역료val) : '',
            사유: 사유,
            상품: product, 그로스: gross, 유형: '자동등록', 비고: 비고LabelText
          };
        }
        return { success: true, type: type, fields: fields };
      } catch(err) {
        return { success: false, error: String(err) };
      }
    },

    parseGaJungjiText: async function(token, text) {
      try {
        const raw = String(text || '').replace(/\r\n/g, '\n').trim();
        if (!raw) return { success: false, error: '내용이 없습니다.' };
        const lines = raw.split('\n').map(l => l.replace(/\r/g, '')).filter(l => l.trim().length > 0);
        if (lines.length < 2) return { success: false, error: '헤더행과 데이터행이 모두 필요합니다(엑셀에서 표 전체를 그대로 복사해 붙여넣어 주세요).' };
        const headerCells = lines[0].split('\t').map(h => h.trim());
        const GAJUNGJI_HEADER_MAP_ = {
          '차량': 'car', '계약번호': 'contractNo', '고객서비스번호': 'custNo', '계약처명': 'company',
          '등록일': 'regDate', '만료일': 'dueDate', 'O/D': 'od', '용역료': 'amount', '구분': 'gubun',
          '일보등록(유,무)': 'registered', '일보등록': 'registered', '복구예정': 'restorePlan',
          '대응자': 'responder', '담당영업': 'salesRep', '내용': 'note'
        };
        const keyOf = headerCells.map(h => GAJUNGJI_HEADER_MAP_[h] || GAJUNGJI_HEADER_MAP_[h.replace(/\s+/g, '')] || null);
        if (keyOf.indexOf('company') === -1 || keyOf.indexOf('contractNo') === -1) {
          return { success: false, error: '표 형식을 인식하지 못했습니다. 헤더행(차량/계약번호/계약처명/등록일/만료일/...)을 포함해 붙여넣어 주세요.' };
        }
        const today = getTzToday();
        const rows = [];
        for (let li = 1; li < lines.length; li++) {
          const cells = lines[li].split('\t');
          if (cells.every(c => !c || !c.trim())) continue;
          const rec = {};
          keyOf.forEach((k, idx) => { if (k) rec[k] = (cells[idx] || '').trim(); });
          if (!rec.company && !rec.contractNo) continue;
          const regDateParsed = rec.regDate ? ruleParseFindDate_(rec.regDate, today) : '';
          const dueDateParsed = rec.dueDate ? ruleParseFindDate_(rec.dueDate, today) : '';
          const 확정일 = dueDateParsed ? nextWorkingDay_(dueDateParsed) : '';
          const amountNum = rec.amount ? Number(String(rec.amount).replace(/[^0-9]/g, '')) : null;
          const carNum = rec.car ? Number(String(rec.car).replace(/[^0-9]/g, '')) : null;
          const cancelCars = [26, 27, 28, 127, 160, '없음'];
          const 담당차량 = (carNum && cancelCars.indexOf(carNum) !== -1) ? String(carNum) : (rec.car || '');
          const alreadyRegistered = /^y$/i.test(String(rec.registered || '').trim());
          const 사유 = [rec.restorePlan, rec.note].filter(v => v && String(v).trim()).join(' / ');
          rows.push({
            display: {
              차량: rec.car || '', 계약번호: rec.contractNo || '', 고객서비스번호: rec.custNo || '', 계약처명: rec.company || '',
              등록일: rec.regDate || '', 만료일: rec.dueDate || '', 'O/D': rec.od || '', 용역료: rec.amount || '',
              구분: rec.gubun || '', '일보등록': rec.registered || '', 복구예정: rec.restorePlan || '', 대응자: rec.responder || '',
              담당영업: rec.salesRep || '', 내용: rec.note || ''
            },
            alreadyRegistered: alreadyRegistered,
            fields: {
              계약번호: rec.contractNo || 'N', 계약처명: rec.company || '',
              영업담당: rec.salesRep || '', 담당차량: 담당차량,
              접수일: regDateParsed || today, 확정일: 확정일,
              용역료: amountNum !== null && !isNaN(amountNum) ? String(amountNum) : '',
              상품: '알람', 그로스: '일반',
              해약유형: '중지', 유형: '자동등록', 사유: 사유
            }
          });
        }
        if (!rows.length) return { success: false, error: '인식된 데이터 행이 없습니다.' };
        return { success: true, rows: rows };
      } catch(err) {
        return { success: false, error: String(err) };
      }
    },

    // 17. 파일 저장소 관리
    adminListStoredFiles: async function(token) {
      try {
        const list = JSON.parse(localStorage.getItem('ADMIN_STORED_FILES') || '[]');
        return { success: true, files: list };
      } catch(e) {
        return { success: true, files: [] };
      }
    },

    adminUploadStoredFile: async function(token, payload) {
      try {
        let list = JSON.parse(localStorage.getItem('ADMIN_STORED_FILES') || '[]');
        list.push(payload);
        localStorage.setItem('ADMIN_STORED_FILES', JSON.stringify(list));
        return { success: true };
      } catch(e) {
        return { success: true };
      }
    },

    adminDeleteStoredFile: async function(token, id) {
      try {
        let list = JSON.parse(localStorage.getItem('ADMIN_STORED_FILES') || '[]');
        list = list.filter(function(f){ return f.id !== id; });
        localStorage.setItem('ADMIN_STORED_FILES', JSON.stringify(list));
        return { success: true };
      } catch(e) {
        return { success: true };
      }
    }
  };

  // --- google.script.run 프록시 객체 생성 ---
  function createProxy(successHandler, failureHandler) {
    return new Proxy({}, {
      get: function(target, prop) {
        if (prop === 'withSuccessHandler') {
          return function(sh) { return createProxy(sh, failureHandler); };
        }
        if (prop === 'withFailureHandler') {
          return function(fh) { return createProxy(successHandler, fh); };
        }
        return function(...args) {
          const fn = Backend[prop];
          if (typeof fn === 'function') {
            fn.apply(Backend, args)
              .then(res => { if (successHandler) successHandler(res); })
              .catch(err => {
                const errMsg = (err && (err.message || err.details || err.hint)) || (typeof err === 'object' ? JSON.stringify(err) : String(err));
                if (failureHandler) failureHandler(errMsg);
                else console.error('Supabase RPC Error [' + prop + ']:', err);
              });
          } else {
            console.warn('Unhandled Supabase RPC call:', prop);
            if (successHandler) successHandler({ success: true });
          }
        };
      }
    });
  }

  // 전역 google.script.run 주입
  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = createProxy();

  console.log('✓ Supabase Backend Adapter for Google Apps Script initialized.');
})(window);
