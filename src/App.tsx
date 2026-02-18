import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { load } from "@tauri-apps/plugin-store";
import { listen } from "@tauri-apps/api/event";
import {
  Settings as SettingsIcon, MessageSquare,
  Send, Cpu, Eye, EyeOff, RefreshCw,
  Mic, Volume2, BrainCircuit, Pin, PinOff,
  ChevronDown, Camera, Glasses, Square
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./App.css";

interface ChatMessage { role: "user" | "model" | "system"; content: string; }
interface AudioPayload { speaker: string; data: string; amplitude: number; }
interface DeviceInfo { name: string; is_input: boolean; }
interface VoiceHint { id: number; text: string; }

const STORE_PATH = "settings.dat";
let hintIdCounter = 0;

const tabTransition = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 },
  transition: { duration: 0.2, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] },
};

function App() {
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<any[]>([]);
  const [selectedModel, setSelectedModel] = useState("models/gemini-1.5-flash");
  const [activeTab, setActiveTab] = useState<"chat" | "settings" | "voice">("chat");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [suggestions, setSuggestions] = useState<VoiceHint[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [isKeyVisible, setIsKeyVisible] = useState(false);
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState(false);
  const [isProtected, setIsProtected] = useState(true);
  const [isSeeThrough, setIsSeeThrough] = useState(false);

  const [interAmp, setInterAmp] = useState(0);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [interviewerDevice, setInterviewerDevice] = useState<string>("");

  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const stopGeneration = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsLoading(false);
  };

  // Returns tooltip text only when Ghost Mode is off
  const tip = (text: string) => isProtected ? undefined : text;

  // ── SSE Stream helper ──
  const streamSSE = async (
    url: string,
    body: any,
    onChunk: (text: string) => void,
    signal?: AbortSignal
  ): Promise<void> => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal,
    });
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`API Error ${r.status}: ${errText}`);
    }

    const reader = r.body?.getReader();
    if (!reader) throw new Error("No response body");
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events from buffer
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // keep incomplete line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const jsonStr = trimmed.slice(6);
        if (!jsonStr || jsonStr === "[DONE]") continue;
        try {
          const parsed = JSON.parse(jsonStr);
          const chunk = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (chunk) onChunk(chunk);
        } catch { /* skip malformed JSON */ }
      }
    }
  };

  useEffect(() => {
    const unlisten = listen<AudioPayload>("audio-chunk", async (event) => {
      const { speaker, data, amplitude } = event.payload;
      // Only process interviewer audio — user mic is not captured
      if (speaker !== "interviewer") return;
      setInterAmp(amplitude);
      if (!isVoiceActive || !apiKey || !data) return;

      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/${selectedModel}:streamGenerateContent?alt=sse`;
        const prompt = `Ты senior-инженер, помогаешь кандидату на техническом собеседовании. Тебе дан аудиофрагмент голоса интервьюера.

ПЕРВЫМ ДЕЛОМ определи: содержит ли аудио ВОПРОС или ЗАДАНИЕ кандидату?
- Вопрос: прямой вопрос, просьба объяснить, задача, "расскажите о...", "как бы вы...", "что такое...", просьба написать код
- НЕ вопрос: приветствие, small talk, комментарии, переходные фразы, тишина, шум, "давайте перейдём к...", "хорошо", "понятно"

Если это НЕ ВОПРОС — ответь ТОЛЬКО одним словом: SKIP

Если это ВОПРОС — дай РАЗВЁРНУТЫЙ и КОНКРЕТНЫЙ ответ, который кандидат может пересказать своими словами:

**Суть**: одно предложение — что спрашивают
**Ответ**: подробный ответ на 12-15 предложений. Структурируй по блокам если это system design:
- **Компоненты**: какие сервисы, БД, кэши, очереди нужны и почему именно они
- **Потоки данных**: как данные проходят через систему, write path и read path
- **Хранение**: схема данных, выбор БД (SQL vs NoSQL), индексы, партиционирование
- **Масштабирование**: шардирование, репликация, load balancing, CDN
- **Надёжность**: отказоустойчивость, graceful degradation, мониторинг
- **Расчёты**: примерные QPS, объём данных, latency requirements
Используй конкретные технологии, паттерны, цифры, trade-offs. Объясняй КАК и ПОЧЕМУ.
Если это вопрос по архитектуре ПО — раскрой:
- **Паттерны**: CQRS, Event Sourcing, Saga, Circuit Breaker, Strangler Fig, Outbox, etc. — когда применять и почему
- **Принципы**: SOLID, DDD (bounded contexts, aggregates, domain events), Clean/Hexagonal Architecture, разделение слоёв
- **Коммуникация сервисов**: sync (REST, gRPC) vs async (Kafka, RabbitMQ, SQS), choreography vs orchestration, idempotency
- **Обработка ошибок**: retry с exponential backoff, dead letter queues, compensating transactions, eventual consistency
- **Observability**: distributed tracing (Jaeger/Zipkin), structured logging, метрики (RED/USE), alerting
- **Тестирование**: contract tests, integration tests, chaos engineering
Если это алгоритмическая задача — опиши подход пошагово, сложность O(), структуры данных, edge cases.

Отвечай на русском. Давай ответ такой глубины, какой ожидают от senior/staff кандидата.`;

        // Each hint gets a unique ID so parallel streams don't conflict
        const hintId = ++hintIdCounter;
        let accumulated = "";
        let isSkip = false;

        // Add placeholder with unique ID
        setSuggestions(prev => [{ id: hintId, text: "⏳ Слушаю..." }, ...prev].slice(0, 10));

        await streamSSE(
          url,
          {
            contents: [{
              parts: [
                { text: prompt },
                { inlineData: { mimeType: "audio/wav", data: data } }
              ]
            }]
          },
          (chunk) => {
            accumulated += chunk;
            // Check if AI decided this is not a question
            const trimmed = accumulated.trim();
            if (trimmed === "SKIP" || trimmed === "SKIP." || trimmed.startsWith("SKIP\n") || trimmed.startsWith("SKIP ")) {
              isSkip = true;
              // Remove this specific hint by ID
              setSuggestions(prev => prev.filter(h => h.id !== hintId));
              return;
            }
            if (isSkip) return;
            // Update only this specific hint by ID
            setSuggestions(prev =>
              prev.map(h => h.id === hintId ? { ...h, text: accumulated } : h)
            );
          }
        );

        // Remove if empty or skipped
        if (!accumulated || isSkip) {
          setSuggestions(prev => prev.filter(h => h.id !== hintId));
        }
      } catch (e) { console.error(e); }
    });
    return () => { unlisten.then(f => f()); };
  }, [isVoiceActive, apiKey, selectedModel]);

  useEffect(() => {
    load(STORE_PATH).then(async s => {
      const k = await s.get<string>("api_key");
      const m = await s.get<string>("selected_model");
      const id = await s.get<string>("interviewer_device");
      const pinned = await s.get<boolean>("always_on_top");
      const prot = await s.get<boolean>("screen_protection");

      if (k) { setApiKey(k); fetchModels(k); }
      if (m) setSelectedModel(m);
      if (id) setInterviewerDevice(id || "");
      if (pinned !== undefined) {
        setIsAlwaysOnTop(pinned);
        invoke("set_always_on_top", { enabled: pinned });
      }
      if (prot !== undefined) {
        setIsProtected(prot);
        invoke("toggle_screen_share_protection", { enabled: prot });
      }
      refreshDevices();
    });
  }, []);

  const refreshDevices = async () => {
    const devs = await invoke<DeviceInfo[]>("get_audio_devices");
    setDevices(devs);
  };

  const fetchModels = async (key: string) => {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
      const d = await r.json();
      if (d.models) setModels(d.models.filter((m: any) => m.supportedGenerationMethods.includes("generateContent")));
    } catch (e) { }
  };

  const toggleVoiceMode = async () => {
    const newState = !isVoiceActive;
    setIsVoiceActive(newState);
    if (newState) {
      await invoke("start_interview_mode", {
        interviewerDevice: interviewerDevice || null
      });
      setActiveTab("voice");
    }
    else { await invoke("stop_interview_mode"); setInterAmp(0); }
  };

  const toggleAlwaysOnTop = async () => {
    const newVal = !isAlwaysOnTop;
    setIsAlwaysOnTop(newVal);
    saveSettings("always_on_top", newVal);
    await invoke("set_always_on_top", { enabled: newVal });
  };

  const toggleProtection = async () => {
    const newVal = !isProtected;
    setIsProtected(newVal);
    saveSettings("screen_protection", newVal);
    await invoke("toggle_screen_share_protection", { enabled: newVal });
  };

  const saveSettings = async (key: string, val: any) => {
    const s = await load(STORE_PATH);
    await s.set(key, val);
    await s.save();
  };

  const sendMessage = async () => {
    if (!input.trim() || !apiKey || isLoading) return;
    const text = input;
    setMessages(prev => [...prev, { role: "user", content: text }]);
    setInput("");
    setIsLoading(true);

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/${selectedModel}:streamGenerateContent?alt=sse`;
      abortRef.current = new AbortController();

      // Add empty model message
      setMessages(prev => [...prev, { role: "model", content: "" }]);

      await streamSSE(
        url,
        { contents: [{ parts: [{ text }] }] },
        (chunk) => {
          setMessages(prev => {
            if (prev.length === 0) return prev;
            const next = [...prev];
            const last = next[next.length - 1];
            if (!last || last.role !== "model") return prev;
            next[next.length - 1] = { ...last, content: last.content + chunk };
            return next;
          });

          if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
          }
        },
        abortRef.current.signal
      );

      setIsLoading(false);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        setIsLoading(false);
        return;
      }
      console.error(e);
      setMessages(prev => [...prev, { role: "model", content: `❌ ${e instanceof Error ? e.message : String(e)}` }]);
      setIsLoading(false);
    }
  };

  const captureAndAnalyze = async () => {
    if (!apiKey || isLoading) return;
    setIsLoading(true);

    try {
      const screenshotBase64 = await invoke<string>("capture_screenshot");

      setMessages(prev => [...prev, { role: "user", content: "📷 [Screenshot captured]" }]);

      const url = `https://generativelanguage.googleapis.com/v1beta/${selectedModel}:streamGenerateContent?alt=sse`;
      const prompt = "Проанализируй этот скриншот. Если видишь задачу, код, вопрос или проблему - помоги решить, объясни или дай рекомендации на русском языке.";

      abortRef.current = new AbortController();

      // Add empty model message
      setMessages(prev => [...prev, { role: "model", content: "" }]);

      await streamSSE(
        url,
        {
          contents: [{
            parts: [
              { text: prompt },
              { inlineData: { mimeType: "image/png", data: screenshotBase64 } }
            ]
          }]
        },
        (chunk) => {
          setMessages(prev => {
            if (prev.length === 0) return prev;
            const next = [...prev];
            const last = next[next.length - 1];
            if (!last || last.role !== "model") return prev;
            next[next.length - 1] = { ...last, content: last.content + chunk };
            return next;
          });

          if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
          }
        },
        abortRef.current.signal
      );

      setIsLoading(false);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        setIsLoading(false);
        return;
      }
      console.error(e);
      setMessages(prev => [...prev, { role: "model", content: `Ошибка при захвате скриншота: ${e}` }]);
      setIsLoading(false);
    }
  };

  return (
    <div
      className={`app-shell${isProtected ? ' stealth-cursor' : ''}${isSeeThrough ? ' see-through' : ''}`}
      onMouseEnter={() => { if (isSeeThrough) invoke("set_window_opacity", { opacity: 0.7 }); }}
      onMouseLeave={() => { if (isSeeThrough) invoke("set_window_opacity", { opacity: 0.3 }); }}
    >
      {/* ─── Header ─── */}
      <header className="top-bar">
        <div className="top-bar-left">
          <div className="top-bar-icon">
            <Cpu size={18} />
          </div>
          <div className="top-bar-text">
            <div className="top-bar-title-row">
              <h1 className="top-bar-title">Interview Copilot</h1>
              <span className="top-bar-badge">Stealth</span>
            </div>
            <div className="top-bar-subtitle-row">
              <span className="model-chip">{selectedModel.split('/').pop()}</span>
              {isVoiceActive && (
                <div className="voice-meter">
                  {[1, 2, 3].map(i => (
                    <motion.div
                      key={i}
                      animate={{ height: Math.max(2, Math.min(10, (interAmp / 5000) * (i * 2))) }}
                      className="voice-meter-bar"
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="top-bar-actions">
          <button
            id="btn-pin"
            onClick={toggleAlwaysOnTop}
            className={`btn-icon-m3 ${isAlwaysOnTop ? "active" : ""}`}
            title={tip("Always on top")}
          >
            {isAlwaysOnTop ? <Pin size={16} /> : <PinOff size={16} />}
          </button>
          <button
            id="btn-ghost"
            onClick={toggleProtection}
            className={`btn-icon-m3 ghost-toggle ${isProtected ? "active" : ""}`}
            title={tip("Ghost mode (screen share protection)")}
          >
            {isProtected ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
          <button
            id="btn-seethrough"
            onClick={async () => {
              const next = !isSeeThrough;
              setIsSeeThrough(next);
              await invoke("set_window_opacity", { opacity: next ? 0.3 : 1.0 });
            }}
            className={`btn-icon-m3 ${isSeeThrough ? 'active' : ''}`}
            title={tip("See-through mode")}
          >
            <Glasses size={16} />
          </button>
          <button
            id="btn-screenshot"
            onClick={captureAndAnalyze}
            className={`btn-icon-m3 ${isLoading ? "active" : ""}`}
            title={tip("Capture screenshot & analyze")}
            disabled={isLoading || !apiKey}
          >
            <Camera size={16} />
          </button>
          <button
            id="btn-voice"
            onClick={toggleVoiceMode}
            className={`btn-icon-m3 primary ${isVoiceActive ? "active" : ""}`}
            title={tip("Voice hints")}
          >
            <Mic size={16} />
          </button>
        </div>
      </header>

      {/* ─── Main Content ─── */}
      <main className="main-content">
        <div className="tab-strip">
          <button
            id="tab-chat"
            className={`tab-pill ${activeTab === "chat" ? "active" : ""}`}
            onClick={() => setActiveTab("chat")}
          >
            <MessageSquare size={14} />
            <span>Chat</span>
          </button>
          <button
            id="tab-voice"
            className={`tab-pill ${activeTab === "voice" ? "active" : ""}`}
            onClick={() => setActiveTab("voice")}
          >
            <BrainCircuit size={14} />
            <span>Voice Hints</span>
          </button>
          <button
            id="tab-settings"
            className={`tab-pill ${activeTab === "settings" ? "active" : ""}`}
            onClick={() => setActiveTab("settings")}
          >
            <SettingsIcon size={14} />
            <span>Settings</span>
          </button>
        </div>

        <AnimatePresence mode="wait">
          {/* ─── Chat Tab ─── */}
          {activeTab === "chat" ? (
            <motion.div key="chat" className="chat-wrapper" {...tabTransition}>
              <div ref={scrollRef} className="chat-container">
                {messages.length === 0 && !isLoading && (
                  <div className="chat-empty">
                    <div className="chat-empty-icon">
                      <MessageSquare size={22} />
                    </div>
                    <div className="chat-empty-text">
                      Ask a question or capture a screenshot to get started
                    </div>
                  </div>
                )}
                {messages.map((m, i) => (
                  <div key={i} className={`m3-bubble ${m.role === 'user' ? 'bubble-user' : 'bubble-model'}`}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                  </div>
                ))}
                {isLoading && (
                  <div className="typing-dots">
                    <div className="typing-dot" />
                    <div className="typing-dot" />
                    <div className="typing-dot" />
                  </div>
                )}
              </div>
              <div className="input-field-container">
                <input
                  id="chat-input"
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && sendMessage()}
                  placeholder="Ask something..."
                />
                {isLoading ? (
                  <button id="btn-stop" onClick={stopGeneration} className="btn-send-m3 btn-stop" title={tip("Stop generation")}>
                    <Square size={14} />
                  </button>
                ) : (
                  <button id="btn-send" onClick={sendMessage} className="btn-send-m3">
                    <Send size={16} />
                  </button>
                )}
              </div>
            </motion.div>

            /* ─── Voice Tab ─── */
          ) : activeTab === "voice" ? (
            <motion.div key="voice" className="voice-tab-content" {...tabTransition}>
              <div className="voice-header">
                <h2 className="voice-header-title">
                  <BrainCircuit size={18} /> Hints
                </h2>
                <div className="voice-badges">
                  <div className={`voice-status-badge ${interAmp > 300 ? 'active system-active' : 'inactive'}`}>Interviewer</div>
                  {isLoading && (
                    <button onClick={stopGeneration} className="btn-icon-m3 btn-stop-mini" title={tip("Stop generation")}>
                      <Square size={12} />
                    </button>
                  )}
                </div>
              </div>

              <div className="voice-hints-list">
                {suggestions.length === 0 && (
                  <div className="voice-empty">
                    <div className="voice-empty-card">
                      <Volume2 size={28} />
                      <div className="voice-empty-info">
                        <div className="voice-empty-title">Waiting for interview</div>
                        <div className="voice-empty-desc">
                          Start Zoom / Google Meet and say something. The app will auto-generate hints here.
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                {suggestions.map((hint) => (
                  <motion.div
                    key={hint.id}
                    initial={{ x: -12, opacity: 0 }}
                    animate={{ x: 0, opacity: 1 }}
                    transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                    className="settings-card-m3 voice-hint-card"
                  >
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{hint.text}</ReactMarkdown>
                  </motion.div>
                ))}
              </div>
            </motion.div>

            /* ─── Settings Tab ─── */
          ) : (
            <motion.div key="settings" className="settings-container" {...tabTransition}>
              <h2 className="settings-title">Settings</h2>

              {/* Model selector */}
              <div className="settings-card-m3">
                <span className="m3-label">Selected AI Model</span>
                <div className="select-wrapper">
                  <select
                    id="select-model"
                    value={selectedModel}
                    onChange={e => { setSelectedModel(e.target.value); saveSettings("selected_model", e.target.value); }}
                    className="m3-input-text"
                  >
                    {models.length > 0 ? (
                      models.map(m => <option key={m.name} value={m.name}>{m.displayName || m.name}</option>)
                    ) : (
                      <option value="models/gemini-1.5-flash">Gemini 1.5 Flash (Default)</option>
                    )}
                  </select>
                  <ChevronDown size={14} className="select-arrow" />
                </div>
              </div>

              {/* API Key */}
              <div className="settings-card-m3">
                <span className="m3-label">API Key</span>
                <div className="api-key-wrapper">
                  <input
                    id="input-api-key"
                    type={isKeyVisible ? "text" : "password"}
                    value={apiKey}
                    onChange={e => { setApiKey(e.target.value); saveSettings("api_key", e.target.value); }}
                    className="m3-input-text"
                  />
                  <button onClick={() => setIsKeyVisible(!isKeyVisible)} className="api-key-toggle">
                    {isKeyVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>



              {/* Interviewer source */}
              <div className="settings-card-m3">
                <span className="m3-label">Interviewer Source</span>
                <select
                  id="select-interviewer"
                  value={interviewerDevice}
                  onChange={e => { setInterviewerDevice(e.target.value); saveSettings("interviewer_device", e.target.value); }}
                  className="m3-input-text"
                >
                  <option value="">Default Output</option>
                  <optgroup label="System / Loopback (Zoom, Meet)">
                    {devices
                      .filter(d => !d.is_input && d.name.toLowerCase().includes("loopback"))
                      .map(d => (
                        <option key={d.name} value={d.name}>{d.name}</option>
                      ))}
                  </optgroup>
                  <optgroup label="Speakers / Headphones">
                    {devices
                      .filter(d => !d.is_input && !d.name.toLowerCase().includes("loopback"))
                      .map(d => (
                        <option key={d.name} value={d.name}>{d.name}</option>
                      ))}
                  </optgroup>
                  <optgroup label="Direct Inputs">
                    {devices
                      .filter(d => d.is_input)
                      .map(d => (
                        <option key={d.name} value={d.name}>{d.name}</option>
                      ))}
                  </optgroup>
                </select>
              </div>

              {/* Ghost mode toggle */}
              <div className="settings-card-m3 settings-toggle-card">
                <div className="settings-toggle-info">
                  <div className="settings-toggle-title">Ghost Mode</div>
                  <div className="settings-toggle-desc">Protect window from sharing</div>
                </div>
                <div onClick={toggleProtection} className={`m3-toggle ${isProtected ? 'active' : ''}`}>
                  <div className="m3-toggle-ball" />
                </div>
              </div>

              <button id="btn-refresh-devices" onClick={refreshDevices} className="btn-refresh">
                <RefreshCw size={14} /> Refresh Devices
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

export default App;
