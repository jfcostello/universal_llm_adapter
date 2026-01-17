export function nowIso() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

export function appendLog(el, line) {
  el.textContent += `${line}\n`;
  el.scrollTop = el.scrollHeight;
}

export function setTag(el, text, kind = 'neutral') {
  el.textContent = text;
  el.classList.remove('ok', 'bad');
  if (kind === 'ok') el.classList.add('ok');
  if (kind === 'bad') el.classList.add('bad');
}

export function assertNonEmpty(value, message) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) throw new Error(message);
  return trimmed;
}

export function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

export function buildSessionUpdate({ systemPrompt }) {
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

export function buildUserMessage(text) {
  return {
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }]
    }
  };
}

export function buildResponseCreate() {
  return { type: 'response.create' };
}

export function buildResponseCancel() {
  return { type: 'response.cancel' };
}

export async function waitForIceGatheringComplete(pc, timeoutMs = 10_000) {
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

export async function mintClientSecret({ adapterUrl, adapterKey, model, systemPrompt }) {
  const res = await fetch(`${adapterUrl.replace(/\\/$/, '')}/realtime/webrtc/client-secret`, {
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

export function makeOpenAIWebRTCUrl(model) {
  const m = encodeURIComponent(model);
  return `https://api.openai.com/v1/realtime?model=${m}`;
}

