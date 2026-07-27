/* ============================================================
 * ちょむちゃんエンジン（Project SLM）フェーズ1
 * 設計図v2準拠。台詞は全部 dict/ 側。ここにはロジックだけ。
 * 凍結ライン300行（超えそうなら辞書側でできないか疑うこと）
 * ============================================================ */
const Chomu = (() => {
  // ---------- CONFIG（調整はここ。台詞はdictへ） ----------
  const CFG = {
    saveKey: 'slm_save_v1',
    replyDelayMs: 220,                    // 人間っぽいタメ
    needsPerHour: { hunger: 4.2, play: 8.4, attention: 12.5, sleepiness: 6.3 },
    sleepRecoverPerHour: 100,             // 睡眠中のねむけ回復
    hungerAsleepFactor: 0.5,              // 寝てる間おなかは半分だけ減る
    moodW: { hunger: 0.30, play: 0.25, attention: 0.30, sleepiness: 0.15 },
    begAt: 70, interruptAt: 90,           // おねだり／割り込みの閾値
    begCooldownMs: 5 * 60 * 1000,
    memTalkCooldownMs: 8 * 60 * 1000, memTalkChance: 1 / 120,  // 自発recall：クールダウン後、毎秒1/120で発火
    drowsyAfterMs: 3 * 60 * 1000, asleepAfterMs: 2 * 60 * 1000,
    feedValue: 45, playValue: 50, petValue: 40,
    memoryUseBonus: 15,
    happyMs: 5000,
    timeScale: 1                          // ?debug=N で加速
  };

  // ---------- 状態（保存の器：設計図v2スキーマ） ----------
  const defaultSave = () => ({
    profile: { petName: 'ちょむちゃん', callName: null, firstMetAt: Date.now(), treasureSlots: 3 },
    needs: { hunger: 20, play: 30, attention: 20, sleepiness: 10, lastTickAt: Date.now() },
    sleep: { state: 'awake', lastInputAt: Date.now() },
    memories: [], events: [], dreams: [],   // events/dreams はフェーズ2で本格運用（器は今から）
    session: { lastTopic: null, lastBotWords: [], askedThisSession: false, lastBegAt: {} }
  });
  let S = null, D = null, hooks = {}, lastHappyAt = 0, memSeq = 0, lastClassifyWord = null, lastMemTalkWord = null;
  let pending = null; // {type:'awaiting_name'|'confirm_name', cand}
  let pendingAsk = null; // {word} 「すきなのかにゃ？」ときいた対象（次の「うん」で学習）

  const save = () => { try { localStorage.setItem(CFG.saveKey, JSON.stringify(S)); } catch (e) {} };
  const load = () => { try { const j = localStorage.getItem(CFG.saveKey); return j ? JSON.parse(j) : null; } catch (e) { return null; } };

  // ---------- ユーティリティ ----------
  const kataToHira = s => s.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
  const norm = s => kataToHira((s || '').trim().normalize('NFKC').toLowerCase());
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const clamp = v => Math.max(0, Math.min(100, v));
  const nowMs = () => Date.now();

  // ---------- 辞書ロード（埋め込み or fetch） ----------
  async function loadDict() {
    if (window.CHOMU_DICT) { D = window.CHOMU_DICT; }
    else {
      const files = ['innate/words.json', 'innate/self.json', 'topics/greet.json',
        'topics/food.json', 'topics/game.json', 'topics/chat.json', 'topics/daily.json', 'topics/writing.json', 'topics/hobby.json', 'topics/season.json',
        'core/templates.json', 'core/fallback.json'];
      D = { rules: [], words: null, tpl: null, fb: null };
      for (const f of files) {
        const j = await (await fetch('dict/' + f)).json();
        if (f.includes('words')) D.words = j;
        else if (f.includes('templates')) D.tpl = j;
        else if (f.includes('fallback')) D.fb = j;
        else D.rules.push(j);
      }
    }
    // 生得辞書のひらがなインデックス（ゲーム/げーむ両対応）
    D.wordIndex = {};
    for (const [w, cat] of Object.entries(D.words.words)) D.wordIndex[norm(w)] = { word: w, cat };
    // 最長一致用ソート済みキー（「日本」に「本」で反応する事故の防止）
    D.sortedKeys = Object.keys(D.wordIndex).sort((a, b) => b.length - a.length);
  }

  // ---------- ご機嫌（導出値。保存しない） ----------
  const mood = () => clamp(100 - (S.needs.hunger * CFG.moodW.hunger + S.needs.play * CFG.moodW.play +
    S.needs.attention * CFG.moodW.attention + S.needs.sleepiness * CFG.moodW.sleepiness));

  // ---------- tick：心臓の鼓動（実時刻差分） ----------
  function tick() {
    const now = nowMs();
    const dtH = ((now - S.needs.lastTickAt) * CFG.timeScale) / 3600000;
    S.needs.lastTickAt = now;
    const asleep = S.sleep.state === 'asleep';
    S.needs.hunger = clamp(S.needs.hunger + CFG.needsPerHour.hunger * dtH * (asleep ? CFG.hungerAsleepFactor : 1));
    if (!asleep) {
      S.needs.play = clamp(S.needs.play + CFG.needsPerHour.play * dtH);
      S.needs.attention = clamp(S.needs.attention + CFG.needsPerHour.attention * dtH);
      S.needs.sleepiness = clamp(S.needs.sleepiness + CFG.needsPerHour.sleepiness * dtH);
    } else {
      S.needs.sleepiness = clamp(S.needs.sleepiness - CFG.sleepRecoverPerHour * dtH);
      if (S.needs.sleepiness <= 5) wake(false); // ぐっすり寝たら自然に起きる
    }
    sleepCheck(now); if (!begCheck(now)) memTalkCheck(now); save(); emitState();
  }

  function sleepCheck(now) {
    const idle = (now - S.sleep.lastInputAt) * CFG.timeScale;
    if (S.sleep.state === 'awake' && idle > CFG.drowsyAfterMs && S.needs.sleepiness > 50) {
      S.sleep.state = 'drowsy'; botSay(pick(D.tpl.sleep.drowsy));
    } else if (S.sleep.state === 'drowsy' && idle > CFG.drowsyAfterMs + CFG.asleepAfterMs) {
      S.sleep.state = 'asleep'; botSay(pick(D.tpl.sleep.goodnight));
      // ★フェーズ2：ここで忘却処理＝夢の生成（dreams[]へ）が走る
    }
  }

  function begCheck(now) {
    if (S.sleep.state !== 'awake' || pending) return;
    for (const k of ['hunger', 'attention', 'play']) {  // 優先度順
      if (S.needs[k] >= CFG.begAt && now - (S.session.lastBegAt[k] || 0) > CFG.begCooldownMs / CFG.timeScale) {
        S.session.lastBegAt[k] = now; botSay(pick(D.tpl.beg[k])); return true;
      }
    }
    return false;
  }

  // 自発recall：おぼえた「すき」を、ちょむちゃんのほうから話題に出す
  function memTalkCheck(now) {
    if (S.sleep.state !== 'awake' || pending || pendingAsk) return;
    if (now - (S.session.lastMemTalkAt || 0) < CFG.memTalkCooldownMs / CFG.timeScale) return;
    if (Math.random() > CFG.memTalkChance * CFG.timeScale) return;  // 確率もゲーム内時間基準
    let likes = S.memories.filter(m => m.relation === 'like');
    if (likes.length > 1) likes = likes.filter(m => m.word !== lastMemTalkWord);  // 記憶1個の序盤は連続OK
    if (!likes.length) return;
    const m = pick(likes);
    lastMemTalkWord = m.word; S.session.lastMemTalkAt = now;
    botSay(pick(D.tpl.memTalk), { word: m.word });
  }

  function wake(sayGroggy) {
    const wasAsleep = S.sleep.state === 'asleep' || S.sleep.state === 'drowsy';
    S.sleep.state = 'awake'; S.sleep.lastInputAt = nowMs();
    if (wasAsleep && sayGroggy) botSay(pick(D.tpl.sleep.wakeGroggy));
    return wasAsleep;
  }

  // ---------- 応答の組み立て ----------
  function fill(t, extra) {
    const map = Object.assign({ name: S.profile.callName || 'きみ', pet: S.profile.petName }, extra || {});
    return t.replace(/\{(\w+)\}/g, (_, k) => map[k] != null ? map[k] : '');
  }
  function tone(t) {
    if (S.sleep.state !== 'awake') return t;
    if (S.needs.hunger >= 80 && Math.random() < 0.5) return pick(D.tpl.tone.hungryPrefix) + t;
    if (mood() < 40 && Math.random() < 0.4) return pick(D.tpl.tone.sulkyPrefix) + t;
    if (S.needs.sleepiness >= 80 && Math.random() < 0.5) return t + pick(D.tpl.tone.sleepySuffix);
    return t;
  }
  function botSay(text, extra) { hooks.onMessage && hooks.onMessage('chomu', fill(text, extra)); emitState(); }
  function reply(text, extra) {
    hooks.onTyping && hooks.onTyping(true);
    setTimeout(() => { hooks.onTyping && hooks.onTyping(false); botSay(tone(fill(text, extra))); save(); }, CFG.replyDelayMs);
  }

  // ---------- 記憶（フェーズ1：名前＋すきなもの。器はフル装備） ----------
  function remember(word, kind, relation, episode) {
    const m = { id: 'm_' + String(++memSeq).padStart(4, '0') + '_' + nowMs().toString(36),
      word, kind: kind || null, relation, strength: 70, learnedAt: nowMs(),
      lastUsedAt: nowMs(), useCount: 0, corrected: false, treasured: false, episode: episode || '' };
    S.memories.push(m); save(); return m;
  }
  const findMemory = t => S.memories.find(m => m.relation === 'like' && norm(t).includes(norm(m.word)));
  function useMemory(m) { m.strength = clamp(m.strength + CFG.memoryUseBonus); m.useCount++; m.lastUsedAt = nowMs(); }

  // ---------- 会話パイプライン（設計図v2の関所順・フェーズ1版） ----------
  function process(raw) {
    const t = raw.trim(); if (!t) return;
    S.sleep.lastInputAt = nowMs();
    S.needs.attention = clamp(S.needs.attention - 15);   // 会話は「かまって」を回復させる
    hooks.onMessage && hooks.onMessage('user', t);
    if (wake(false)) { reply(pick(D.tpl.sleep.wakeGroggy)); return; }  // 寝てた→寝ぼけ返答
    if (pending) return nameFlow(t);                                    // 名前フロー継続
    // ①訂正チェック：★フェーズ2（lastBotWordsの器は運用開始済み）
    const rename = t.match(/(.{1,10}?)って(よんで|呼んで)/);            // 呼び名の変更
    if (rename) { pending = { type: 'confirm_name', cand: rename[1].trim() }; return reply(pick(D.tpl.nameFlow.confirm), { cand: pending.cand }); }
    // ②欲求割り込み
    if (S.needs.hunger >= CFG.interruptAt) return reply(pick(D.tpl.interrupt.hunger));
    if (mood() < 25) return reply(pick(D.tpl.interrupt.sulky));
    // ②.5 わすれて（記憶の削除依頼：「変なものおぼえないで」対応）
    const ntEarly = norm(t);
    if (/(おぼえないで|覚えないで|わすれて|忘れて|きおくをけして|記憶を?消して|おぼえなおして|覚え直して)/.test(ntEarly)) {
      const lastM = S.memories.filter(m => m.relation === 'like').slice(-1)[0];
      if (lastM) { S.memories = S.memories.filter(m => m !== lastM); save(); return reply(pick(D.tpl.forget), { word: lastM.word }); }
      return reply(pick(D.tpl.nothingToForget));
    }
    // ②.6 否定訂正（「うんは好きじゃない」→ その記憶を消す）
    const negLike = t.match(/^(.{1,12}?)(は|のこと)?、?\s*(だい)?(すき|好き)(じゃ|では|く)?な(い|かった)/);
    if (negLike) {
      const negCand = norm(negLike[1].replace(/[、。!！?？\s]/g, ''));
      const negIdx = S.memories.findIndex(m => m.relation === 'like' && norm(m.word) === negCand);
      if (negIdx >= 0) { const w = S.memories[negIdx].word; S.memories.splice(negIdx, 1); save(); return reply(pick(D.tpl.like.negCorrect), { word: w }); }
    }
    // ②.7 「すきなのかにゃ？」ときいたあとの返事（うん→その対象をおぼえる）
    if (pendingAsk) {
      const ask = pendingAsk; pendingAsk = null;
      const flat = norm(t).replace(/[、。!！?？\sｗw〜ー]/g, '');
      const negAns = /(じゃない|ちがう|きらい|嫌い|べつに|ううん|そうでもない|びみょう|微妙|すきじゃ)/.test(flat);
      if (!negAns && /^(うん|そう|はい|ええ|(だい)?(すき|好き))((だい)?(すき|好き))?(だよ|かも|かな|だね)?$/.test(flat)) {
        const exist = S.memories.find(m => m.relation === 'like' && norm(m.word) === norm(ask.word));
        if (exist) { useMemory(exist); return reply(pick(D.tpl.like.already), { word: exist.word }); }
        const askKnown = D.wordIndex[norm(ask.word)];
        remember(ask.word, askKnown ? askKnown.cat : null, 'like', 'きいてみたら、すきっていってた');
        return reply(pick(D.tpl.like.confirmed), { word: ask.word });
      }
      if (/^(いや|ううん|べつに|きらい|嫌い|ちがう|そうでもない|びみょう|微妙|ぜんぜん)/.test(flat)) return reply(pick(D.tpl.like.notLike), { word: ask.word });
      // どちらでもなければ、ふつうの入力としてつづきへ
    }
    // ③すき（likeフロー：あなたのことを覚える）
    // 疑問文（？/なに/どんな…）は「すき宣言」ではないので覚えない
    const isQuestion = /[?？]\s*$/.test(t) || /(なに|何|どれ|だれ|誰|どっち|どんな|どう|なんで)/.test(norm(t));
    const like = !isQuestion && t.match(/^(.*?)(?:の ?こと)?(?:が|も|は)?(?:だい)?(?:すき|好き)/);
    if (like && like[1]) {
      const cand = like[1].replace(/[、。!！?？\s]/g, '');
      const selfWords = ['ちょむ', 'きみ', 'あなた', 'おまえ', 'あんた', norm(S.profile.petName)];
      const isSelf = selfWords.some(w => norm(cand).includes(w));  // 部分一致で自分宛てを除外
      const STOP = ['うん', 'ううん', 'そう', 'そうそう', 'はい', 'いや', 'まあ', 'うーん', 'たぶん', 'これ', 'それ', 'あれ', 'なんか', 'ほんと', 'まじ', 'けっこう', 'やっぱり', 'やっぱ', 'とても', 'すごく', 'ちょっと', 'もう', 'でも', 'あと', 'は', 'が', 'も'];
      if (cand && cand.length <= 12 && !isSelf && !STOP.includes(norm(cand))) {
        const exist = S.memories.find(m => m.relation === 'like' && norm(m.word) === norm(cand));
        if (exist) { useMemory(exist); return reply(pick(D.tpl.like.already), { word: exist.word }); }
        const known = D.wordIndex[norm(cand)];
        remember(cand, known ? known.cat : null, 'like', 'すきっていってた');
        return reply(pick(known ? D.tpl.like.knownCat : D.tpl.like.unknown),
          { word: cand, cat: known ? D.words.categories[known.cat] : '' });
      }
    }
    // ④記憶語マッチ（おぼえた「あなたのこと」）
    const mem = findMemory(t);
    if (mem) { useMemory(mem); return reply(pick(D.tpl.like.recall), { word: mem.word }); }
    // ⑤ルール辞書マッチ（生得self＋topics）
    const nt = norm(t);
    for (const g of D.rules) for (const r of g.rules) {
      const re = new RegExp(r.match, 'u');
      if (re.test(t) || re.test(nt)) { S.session.lastTopic = g.topic; return reply(pick(r.responses)); }
    }
    // ⑤.5 しつもんに気づく（？・「〜かな」「どう思う」等も質問扱い。分類コメントやgeneralに流さない）
    const isQ = /[?？]\s*$/.test(t) || /(かな|かにゃ|だろうか|でしょうか|どうおもう|どう思う|どうなんだろう)[。…〜ー!！]*$/.test(nt);
    if (isQ) {
      // 「〇〇知ってる？」→ 生得辞書をひいて正直にこたえる
      const km = nt.match(/^(.{1,12}?)(って|とか|は|のこと)?、?\s*(しってる|知ってる|わかる|きいたことある|聞いたことある)/);
      if (km && km[1]) {
        const kt = km[1].replace(/[、。\s]/g, '');
        const known = D.wordIndex[kt];
        if (known) return reply(pick(D.fb.question.knowsYes), { word: known.word, cat: D.words.categories[known.cat] });
        return reply(pick(D.fb.question.knowsNo), { word: kt });
      }
      if (/(すき|好き)/.test(nt)) {
        const qm = nt.match(/^(.{1,12}?)(って|とか|は|が|の ?こと)?(だい)?(すき|好き)/);
        let target = qm ? qm[1].replace(/[、。\s]/g, '') : '';
        if (/^(なにか|なんか|なに|何|どんな|どれ|いちばん|一番|ちょむの)/.test(target) || /^(だい)?(すき|好き)/.test(nt)) target = '';
        if (target) {
          const youWords = ['ちょむ', 'きみ', 'あなた', 'おまえ', 'お前', 'わたし', 'ぼく', 'おれ', norm(S.profile.petName)];
          if (youWords.some(w => w && target.includes(w))) return reply(pick(D.fb.question.likeYou));
          const known = D.wordIndex[target];
          return reply(pick(known ? D.fb.question.likeKnown : D.fb.question.likeUnknown), { word: target });
        }
        const lm = S.memories.filter(m2 => m2.relation === 'like').slice(-1)[0];
        if (lm && Math.random() < 0.6) { useMemory(lm); return reply(pick(D.fb.question.likeMeWithMemory), { word: lm.word }); }
        return reply(pick(D.fb.question.likeMe));
      }
      return reply(pick(D.fb.question.generic));
    }
    // ⑥生得辞書の語に反応（分類コメント）※最長一致・同じ語で連発しない
    for (const key of D.sortedKeys) {
      const okLen = key.length >= 2 || /[一-鿿]/.test(key);  // 1文字は漢字のみ許可（き/め等の誤爆防止）
      if (nt.includes(key) && key !== lastClassifyWord && okLen) {
        lastClassifyWord = key; const w = D.wordIndex[key];
        return reply(pick(D.fb.withKnownWord), { word: w.word, cat: D.words.categories[w.cat] });
      }
    }
    // ⑦一軍fallback ※短い未知語には「すきなのかにゃ？」ときいてみる（②.7で返事から学習）
    const shortWord = t.replace(/[、。!！?？\s]/g, '');
    if (shortWord.length >= 2 && shortWord.length <= 10 && /[ぁ-ゖァ-ヶ一-鿿]/.test(shortWord)) {  // かな・漢字ゼロ（数字・絵文字のみ等）はきかない
      pendingAsk = { word: shortWord };
      return reply(pick(D.fb.askLike), { word: shortWord });
    }
    reply(pick(D.fb.general), { input: t.length > 15 ? t.slice(0, 15) + '…' : t });
  }

  function nameFlow(t) {
    if (pending.type === 'awaiting_name') {
      // 「〇〇ってよんで」の「って/と」は"よんで"とセットの時だけ除去（末尾が「と」の名前を守る）
      const cand = t.replace(/(?:って|と)?(?:よんで|呼んで)[、。!！\s]*$/, '').replace(/[、。!！\s]+$/, '').trim();
      if (!cand || cand.length > 10 || /^[\d\s!-/:-@[-`{-~！-／：-＠]+$/.test(cand)) return reply(pick(D.tpl.nameFlow.invalid));
      pending = { type: 'confirm_name', cand };
      return reply(pick(D.tpl.nameFlow.confirm), { cand });
    }
    if (pending.type === 'confirm_name') {
      const nt = norm(t);
      if (/^(うん|はい|そう|いいよ|おけ|ok|おっけ|よろしく|それで)/.test(nt)) {
        S.profile.callName = pending.cand; pending = null; save();
        return reply(pick(D.tpl.nameFlow.saved));
      }
      if (/^(ちがう|いや|だめ|やだ|no|のー)/.test(nt)) { pending = { type: 'awaiting_name' }; return reply(pick(D.tpl.nameFlow.retry)); }
      pending = { type: 'confirm_name', cand: t.trim().slice(0, 10) };  // 言い直しとみなす
      return reply(pick(D.tpl.nameFlow.confirm), { cand: pending.cand });
    }
  }

  // ---------- ボタン系アクション ----------
  const actions = {
    feed() { S.sleep.lastInputAt = nowMs(); wake(true);
      if (S.needs.hunger < 10) return reply(pick(D.tpl.actions.feedFull));
      S.needs.hunger = clamp(S.needs.hunger - CFG.feedValue); lastHappyAt = nowMs(); reply(pick(D.tpl.actions.feed)); },
    playToy() { S.sleep.lastInputAt = nowMs(); wake(true);
      S.needs.play = clamp(S.needs.play - CFG.playValue); S.needs.attention = clamp(S.needs.attention - 10);
      lastHappyAt = nowMs(); reply(pick(D.tpl.actions.playToy)); },
    pet() { S.sleep.lastInputAt = nowMs(); if (wake(true)) return;
      S.needs.attention = clamp(S.needs.attention - CFG.petValue); lastHappyAt = nowMs(); reply(pick(D.tpl.actions.pet)); }
  };

  // ---------- 顔と外部向けステート ----------
  function face() {
    if (S.sleep.state === 'asleep') return 'asleep';
    if (S.sleep.state === 'drowsy') return 'drowsy';
    if (nowMs() - lastHappyAt < CFG.happyMs) return 'happy';
    const m = mood();
    if (S.needs.hunger >= CFG.interruptAt) return 'sad';
    if (m < 40) return 'sulky';
    if (m >= 75) return 'happy';
    return 'normal';
  }
  function emitState() {
    hooks.onState && hooks.onState({ needs: { ...S.needs }, mood: Math.round(mood()), face: face(),
      sleep: S.sleep.state, callName: S.profile.callName, petName: S.profile.petName,
      memories: S.memories.map(m => ({ id: m.id, word: m.word, kind: m.kind, relation: m.relation, strength: Math.round(m.strength) })) });
  }

  // ---------- 公開API ----------
  return {
    async init(h) {
      hooks = h || {};
      const url = new URL(location.href);
      CFG.timeScale = Number(url.searchParams.get('debug')) || 1;
      await loadDict();
      S = load() || defaultSave();
      memSeq = S.memories.length;
      tick(); setInterval(tick, 1000);
      if (!S.profile.callName) { pending = { type: 'awaiting_name' };
        D.tpl.boot.firstMeet.forEach((line, i) => setTimeout(() => botSay(line), 600 + i * 1200)); }
      else botSay(pick(D.tpl.boot.welcomeBack));
      emitState();
    },
    send: t => process(t),
    action: k => actions[k] && actions[k](),
    nudge() { if (S.sleep.state !== 'awake') { wake(true); } S.sleep.lastInputAt = nowMs(); },
    forget(id) { const i = S.memories.findIndex(m => m.id === id);
      if (i >= 0) { const w = S.memories[i].word; S.memories.splice(i, 1); save(); botSay(pick(D.tpl.forget), { word: w }); } },
    debugState: () => ({ S, mood: mood(), pending, timeScale: CFG.timeScale })
  };
})();
