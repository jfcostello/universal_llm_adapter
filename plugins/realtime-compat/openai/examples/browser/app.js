const els = {
  adapterUrl: document.getElementById('adapterUrl'),
  adapterKey: document.getElementById('adapterKey'),
  model: document.getElementById('model'),
  systemPrompt: document.getElementById('systemPrompt'),
  textInput: document.getElementById('textInput'),
  btnConnect: document.getElementById('btnConnect'),
  btnDisconnect: document.getElementById('btnDisconnect'),
  btnSendText: document.getElementById('btnSendText'),
  btnInterrupt: document.getElementById('btnInterrupt'),
  stateTag: document.getElementById('stateTag'),
  pcTag: document.getElementById('pcTag'),
  dcTag: document.getElementById('dcTag'),
  userTranscript: document.getElementById('userTranscript'),
  assistantTranscript: document.getElementById('assistantTranscript'),
  eventLog: document.getElementById('eventLog'),
  remoteAudio: document.getElementById('remoteAudio')
};

function nowIso() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function appendLog(el, line) {
  el.textContent += `${line}\n`;
  el.scrollTop = el.scrollHeight;
}

function setTag(el, text, kind = 'neutral') {
  el.textContent = text;
  el.classList.remove('ok', 'bad');
  if (kind === 'ok') el.classList.add('ok');
  if (kind === 'bad') el.classList.add('bad');
}

function assertNonEmpty(value, message) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) throw new Error(message);
  return trimmed;
}

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function buildSessionUpdate({ systemPrompt }) {
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      instructions: systemPrompt || undefined,
      output_modalities: ['audio'],
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: { model: 'whisper-1' },
          turn_detection: {
            type: 'server_vad',
            create_response: true,
            interrupt_response: false
          }
        },
        output: {
          format: { type: 'audio/pcm', rate: 24000 }
        }
      }
    }
  };
}

function buildUserMessage(text) {
  return {
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }]
    }
  };
}

function buildResponseCreate() {
  return { type: 'response.create' };
}

function buildResponseCancel() {
  return { type: 'response.cancel' };
}

async function waitForIceGatheringComplete(pc, timeoutMs = 10_000) {
  if (pc.iceGatheringState === 'complete') return;

  // Wait for at least one candidate, then give a bit more time for the rest
  let candidateCount = 0;
  let hasSrflx = false;
  let resolved = false;

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (candidateCount > 0) {
          // We have some candidates, proceed anyway
          resolve();
        } else {
          reject(new Error('Timed out waiting for ICE candidates'));
        }
      }
    }, timeoutMs);

    let settleTimeout = null;

    const trySettle = () => {
      // Once we have a srflx candidate, wait 1.5s more then proceed
      if (hasSrflx && !settleTimeout) {
        settleTimeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve();
          }
        }, 1500);
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        candidateCount++;
        if (event.candidate.type === 'srflx' || event.candidate.candidate?.includes('srflx')) {
          hasSrflx = true;
        }
        trySettle();
      } else {
        // null candidate = gathering complete
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          if (settleTimeout) clearTimeout(settleTimeout);
          resolve();
        }
      }
    };

    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete' && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        if (settleTimeout) clearTimeout(settleTimeout);
        resolve();
      }
    };
  });
}

async function mintClientSecret({ adapterUrl, adapterKey, model, systemPrompt }) {
  const res = await fetch(`${adapterUrl.replace(/\/$/, '')}/realtime/webrtc/client-secret`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${adapterKey}`
    },
    body: JSON.stringify({
      provider: 'openai',
      model,
      systemPrompt,
      expiresAfterSeconds: 120
    })
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || `HTTP ${res.status}`;
    throw new Error(`Client secret mint failed: ${msg}`);
  }
  const secret = json?.clientSecret;
  if (!secret || typeof secret !== 'string') {
    throw new Error('Client secret mint failed: missing clientSecret in response');
  }
  return secret;
}

function makeOpenAIWebRTCUrl(model) {
  const m = encodeURIComponent(model);
  return `https://api.openai.com/v1/realtime?model=${m}`;
}

let state = {
  pc: null,
  dc: null,
  localStream: null,
  remoteStream: null,
  connected: false,
  userDraft: '',
  assistantDraft: '',
  assistantSpeakingUntilMs: 0
};

function isAssistantSpeaking() {
  return Date.now() < state.assistantSpeakingUntilMs;
}

function touchAssistantSpeaking(ttlMs = 1200) {
  state.assistantSpeakingUntilMs = Math.max(state.assistantSpeakingUntilMs, Date.now() + ttlMs);
}

function sendEvent(obj) {
  if (!state.dc || state.dc.readyState !== 'open') throw new Error('Data channel is not open');
  state.dc.send(JSON.stringify(obj));
}

function renderTranscriptDrafts() {
  // keep drafts in the logs as the last line; final lines get appended separately
  // drafts are displayed inline with a prefix so it’s obvious they’re partial
  const userBase = els.userTranscript.textContent.split('\n').filter(Boolean);
  const assistantBase = els.assistantTranscript.textContent.split('\n').filter(Boolean);

  const nextUser = [...userBase.filter(l => !l.startsWith('[draft] ')), ...(state.userDraft ? [`[draft] ${state.userDraft}`] : [])];
  const nextAssistant = [
    ...assistantBase.filter(l => !l.startsWith('[draft] ')),
    ...(state.assistantDraft ? [`[draft] ${state.assistantDraft}`] : [])
  ];

  els.userTranscript.textContent = nextUser.join('\n') + (nextUser.length ? '\n' : '');
  els.assistantTranscript.textContent = nextAssistant.join('\n') + (nextAssistant.length ? '\n' : '');

  els.userTranscript.scrollTop = els.userTranscript.scrollHeight;
  els.assistantTranscript.scrollTop = els.assistantTranscript.scrollHeight;
}

function appendFinalTranscript(side, text) {
  const clean = String(text ?? '').trim();
  if (!clean) return;
  if (side === 'user') appendLog(els.userTranscript, clean);
  if (side === 'assistant') appendLog(els.assistantTranscript, clean);
}

function handleProviderEvent(evt) {
  const type = String(evt?.type ?? '');

  if (type === 'session.updated') {
    appendLog(els.eventLog, `${nowIso()} [session.updated] ready`);
    return;
  }

  if (type === 'error') {
    const msg = evt?.error?.message || 'unknown';
    appendLog(els.eventLog, `${nowIso()} [error] ${msg}`);
    return;
  }

  if (type === 'input_audio_buffer.speech_started') {
    appendLog(els.eventLog, `${nowIso()} [vad] user speech started`);
    if (isAssistantSpeaking()) {
      appendLog(els.eventLog, `${nowIso()} [barge-in] cancelling assistant response`);
      try {
        sendEvent(buildResponseCancel());
        els.remoteAudio.muted = true;
        setTimeout(() => (els.remoteAudio.muted = false), 400);
      } catch (err) {
        appendLog(els.eventLog, `${nowIso()} [barge-in] cancel failed: ${err?.message || err}`);
      }
    }
    return;
  }

  if (type === 'conversation.item.input_audio_transcription.delta') {
    const delta = String(evt?.delta ?? '');
    if (delta) {
      state.userDraft += delta;
      renderTranscriptDrafts();
    }
    return;
  }

  if (type === 'conversation.item.input_audio_transcription.completed') {
    const finalText = String(evt?.transcript ?? '').trim();
    const resolved = finalText || state.userDraft.trim();
    if (resolved) appendFinalTranscript('user', resolved);
    state.userDraft = '';
    renderTranscriptDrafts();
    return;
  }

  if (type === 'response.output_audio_transcript.delta') {
    const delta = String(evt?.delta ?? '');
    if (delta) {
      touchAssistantSpeaking();
      state.assistantDraft += delta;
      renderTranscriptDrafts();
    }
    return;
  }

  if (type === 'response.output_audio_transcript.done') {
    const finalText = String(evt?.transcript ?? '').trim();
    const resolved = finalText || state.assistantDraft.trim();
    if (resolved) appendFinalTranscript('assistant', resolved);
    state.assistantDraft = '';
    renderTranscriptDrafts();
    return;
  }

  if (type === 'response.done') {
    // end of response; let the speaking flag expire naturally
    return;
  }
}

function setUiConnected(connected) {
  state.connected = connected;
  els.btnConnect.disabled = connected;
  els.btnDisconnect.disabled = !connected;
  els.btnSendText.disabled = !connected;
  els.btnInterrupt.disabled = !connected;
  setTag(els.stateTag, `state: ${connected ? 'connected' : 'idle'}`, connected ? 'ok' : 'neutral');
}

async function connect() {
  setUiConnected(false);
  setTag(els.pcTag, 'pc: connecting', 'neutral');
  setTag(els.dcTag, 'dc: connecting', 'neutral');
  els.eventLog.textContent = '';

  const adapterUrl = assertNonEmpty(els.adapterUrl.value, 'Adapter server URL is required');
  const adapterKey = assertNonEmpty(els.adapterKey.value, 'Adapter auth token is required');
  const model = assertNonEmpty(els.model.value, 'Model is required');
  const systemPrompt = String(els.systemPrompt.value ?? '').trim();

  appendLog(els.eventLog, `${nowIso()} minting client secret via adapter server...`);
  const clientSecret = await mintClientSecret({ adapterUrl, adapterKey, model, systemPrompt });
  appendLog(els.eventLog, `${nowIso()} minted client secret (not printed)`);

  appendLog(els.eventLog, `${nowIso()} requesting microphone...`);
  const localStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });
  state.localStream = localStream;
  appendLog(els.eventLog, `${nowIso()} microphone ready`);

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });
  state.pc = pc;

  pc.oniceconnectionstatechange = () => {
    setTag(els.pcTag, `pc: ${pc.iceConnectionState}`, pc.iceConnectionState === 'connected' ? 'ok' : 'neutral');
    appendLog(els.eventLog, `${nowIso()} [pc] iceConnectionState=${pc.iceConnectionState}`);
  };
  pc.onconnectionstatechange = () => {
    appendLog(els.eventLog, `${nowIso()} [pc] connectionState=${pc.connectionState}`);
  };
  pc.ontrack = (event) => {
    const stream = event.streams?.[0];
    if (!stream) return;
    state.remoteStream = stream;
    els.remoteAudio.srcObject = stream;
    els.remoteAudio.play().catch(() => {});
    appendLog(els.eventLog, `${nowIso()} [pc] remote audio track attached`);
  };

  for (const track of localStream.getTracks()) {
    pc.addTrack(track, localStream);
  }

  const dc = pc.createDataChannel('oai-events');
  state.dc = dc;

  dc.onopen = () => {
    setTag(els.dcTag, 'dc: open', 'ok');
    appendLog(els.eventLog, `${nowIso()} [dc] open`);

    const update = buildSessionUpdate({ systemPrompt });
    sendEvent(update);
    appendLog(els.eventLog, `${nowIso()} [dc] -> session.update`);
  };

  dc.onclose = () => {
    setTag(els.dcTag, `dc: closed`, 'bad');
    appendLog(els.eventLog, `${nowIso()} [dc] closed`);
  };

  dc.onerror = () => {
    setTag(els.dcTag, `dc: error`, 'bad');
    appendLog(els.eventLog, `${nowIso()} [dc] error`);
  };

  dc.onmessage = (msgEvent) => {
    const text = String(msgEvent?.data ?? '');
    const parsed = safeJsonParse(text);
    if (!parsed.ok) {
      appendLog(els.eventLog, `${nowIso()} [dc] <- (non-json) ${text}`);
      return;
    }
    const evt = parsed.value;
    const type = String(evt?.type ?? '');
    appendLog(els.eventLog, `${nowIso()} [dc] <- ${type || 'event'}`);
    handleProviderEvent(evt);
  };

  appendLog(els.eventLog, `${nowIso()} creating SDP offer...`);
  const offer = await pc.createOffer({ offerToReceiveAudio: true });
  await pc.setLocalDescription(offer);
  await waitForIceGatheringComplete(pc);
  const offerSdp = pc.localDescription?.sdp;
  if (!offerSdp) throw new Error('Missing localDescription.sdp');

  appendLog(els.eventLog, `${nowIso()} sending SDP offer to provider...`);
  const sdpRes = await fetch(makeOpenAIWebRTCUrl(model), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${clientSecret}`,
      'content-type': 'application/sdp'
    },
    body: offerSdp
  });
  const answerSdp = await sdpRes.text();
  if (!sdpRes.ok) {
    throw new Error(`SDP exchange failed: HTTP ${sdpRes.status} ${answerSdp.slice(0, 200)}`);
  }

  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  appendLog(els.eventLog, `${nowIso()} SDP answer applied`);

  setUiConnected(true);
}

async function disconnect() {
  setUiConnected(false);
  setTag(els.pcTag, 'pc: -', 'neutral');
  setTag(els.dcTag, 'dc: -', 'neutral');

  try {
    state.dc?.close();
  } catch {}
  try {
    state.pc?.close();
  } catch {}
  try {
    state.localStream?.getTracks()?.forEach((t) => t.stop());
  } catch {}

  state = {
    pc: null,
    dc: null,
    localStream: null,
    remoteStream: null,
    connected: false,
    userDraft: '',
    assistantDraft: '',
    assistantSpeakingUntilMs: 0
  };
}

async function sendText() {
  const text = String(els.textInput.value ?? '').trim();
  if (!text) return;
  els.textInput.value = '';

  appendLog(els.eventLog, `${nowIso()} [dc] -> user text`);
  sendEvent(buildUserMessage(text));
  sendEvent(buildResponseCreate());
}

async function interrupt() {
  appendLog(els.eventLog, `${nowIso()} [dc] -> response.cancel`);
  sendEvent(buildResponseCancel());
}

els.btnConnect.addEventListener('click', async () => {
  els.btnConnect.disabled = true;
  try {
    await connect();
  } catch (err) {
    appendLog(els.eventLog, `${nowIso()} [fatal] ${err?.message || err}`);
    setTag(els.stateTag, 'state: error', 'bad');
    await disconnect();
  } finally {
    els.btnConnect.disabled = false;
  }
});

els.btnDisconnect.addEventListener('click', async () => {
  await disconnect();
});

els.btnSendText.addEventListener('click', async () => {
  try {
    await sendText();
  } catch (err) {
    appendLog(els.eventLog, `${nowIso()} [sendText] ${err?.message || err}`);
  }
});

els.btnInterrupt.addEventListener('click', async () => {
  try {
    await interrupt();
  } catch (err) {
    appendLog(els.eventLog, `${nowIso()} [interrupt] ${err?.message || err}`);
  }
});

els.textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    els.btnSendText.click();
  }
});

setUiConnected(false);
appendLog(els.eventLog, `${nowIso()} idle. Start dev server (README.md), then click Connect.`);

