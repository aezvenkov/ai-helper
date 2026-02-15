import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { load } from "@tauri-apps/plugin-store";
import { listen } from "@tauri-apps/api/event";
import {
  Settings as SettingsIcon, MessageSquare,
  Send, Cpu, Eye, EyeOff, RefreshCw,
  Mic, Volume2, BrainCircuit, Pin, PinOff,
  ChevronDown
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./App.css";

interface ChatMessage { role: "user" | "model" | "system"; content: string; }
interface AudioPayload { speaker: string; data: string; amplitude: number; }
interface DeviceInfo { name: string; is_input: boolean; }

const STORE_PATH = "settings.dat";

function App() {
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<any[]>([]);
  const [selectedModel, setSelectedModel] = useState("models/gemini-1.5-flash");
  const [activeTab, setActiveTab] = useState<"chat" | "settings" | "voice">("chat");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [isKeyVisible, setIsKeyVisible] = useState(false);
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState(false);
  const [isProtected, setIsProtected] = useState(true);

  const [userAmp, setUserAmp] = useState(0);
  const [interAmp, setInterAmp] = useState(0);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [userDevice, setUserDevice] = useState<string>("");
  const [interviewerDevice, setInterviewerDevice] = useState<string>("");

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unlisten = listen<AudioPayload>("audio-chunk", async (event) => {
      const { speaker, data, amplitude } = event.payload;
      if (speaker === "user") setUserAmp(amplitude);
      if (speaker === "interviewer") setInterAmp(amplitude);
      if (!isVoiceActive || !apiKey || !data) return;

      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/${selectedModel}:generateContent`;
        const prompt = speaker === "interviewer"
          ? "Это голос интервьюера. Кратко переведи вопрос и дай 3 тезиса для ответа на русском."
          : "Это мой голос. Проверь мой технический ответ на точность.";

        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: prompt },
                { inlineData: { mimeType: "audio/wav", data: data } }
              ]
            }]
          })
        });

        const resData = await response.json();
        const hint = resData.candidates?.[0]?.content?.parts?.[0]?.text;
        if (hint) setSuggestions(prev => [hint, ...prev].slice(0, 10));
      } catch (e) { console.error(e); }
    });
    return () => { unlisten.then(f => f()); };
  }, [isVoiceActive, apiKey, selectedModel]);

  useEffect(() => {
    load(STORE_PATH).then(async s => {
      const k = await s.get<string>("api_key");
      const m = await s.get<string>("selected_model");
      const ud = await s.get<string>("user_device");
      const id = await s.get<string>("interviewer_device");
      const pinned = await s.get<boolean>("always_on_top");
      const prot = await s.get<boolean>("screen_protection");

      if (k) { setApiKey(k); fetchModels(k); }
      if (m) setSelectedModel(m);
      if (ud) setUserDevice(ud || "");
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
        userDevice: userDevice || null,
        interviewerDevice: interviewerDevice || null
      });
      setActiveTab("voice");
    }
    else { await invoke("stop_interview_mode"); setUserAmp(0); setInterAmp(0); }
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
    setMessages(prev => [...prev, { role: "user", content: input }]);
    setInput(""); setIsLoading(true);
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/${selectedModel}:generateContent`;
      const r = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({ contents: [{ parts: [{ text: input }] }] })
      });
      const d = await r.json();
      setMessages(prev => [...prev, { role: "model", content: d.candidates?.[0]?.content?.parts?.[0]?.text || "Error" }]);
    } catch (e) { console.error(e); } finally { setIsLoading(false); }
  };

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="flex items-center gap-3">
          <div className="bg-gradient-to-br from-violet-600 to-indigo-700 p-2 rounded-xl shadow-lg border border-white/10">
            <Cpu size={18} className="text-white" />
          </div>
          <div>
            <h1 className="text-[13px] font-black text-white leading-tight">AI Assistant</h1>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-[8px] text-purple-400 font-bold uppercase tracking-wider">{selectedModel.split('/').pop()}</span>
              {isVoiceActive && (
                <div className="flex gap-0.5 items-end h-2">
                  {[1, 2, 3].map(i => (
                    <motion.div key={i} animate={{ height: Math.max(2, Math.min(8, (userAmp / 5000) * (i * 2))) }} className="w-0.5 bg-emerald-400 rounded-full" />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button onClick={toggleAlwaysOnTop} className={`btn-icon-m3 ${isAlwaysOnTop ? 'active' : ''}`} title="Always on Top">
            {isAlwaysOnTop ? <Pin size={16} /> : <PinOff size={16} />}
          </button>
          <button onClick={toggleVoiceMode} className={`btn-icon-m3 ${isVoiceActive ? 'active !text-emerald-400' : ''}`} title="Voice Mode">
            <Mic size={16} />
          </button>
          <div className="w-px h-6 bg-white/10 mx-1" />
          <button onClick={() => setActiveTab("chat")} className={`btn-icon-m3 ${activeTab === 'chat' ? 'active' : ''}`}><MessageSquare size={16} /></button>
          <button onClick={() => setActiveTab("voice")} className={`btn-icon-m3 ${activeTab === 'voice' ? 'active' : ''}`}><BrainCircuit size={16} /></button>
          <button onClick={() => setActiveTab("settings")} className={`btn-icon-m3 ${activeTab === 'settings' ? 'active' : ''}`}><SettingsIcon size={16} /></button>
        </div>
      </header>

      <main className="main-content">
        <AnimatePresence mode="wait">
          {activeTab === "chat" ? (
            <motion.div key="chat" className="flex-1 flex flex-col h-full overflow-hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div ref={scrollRef} className="chat-container custom-scrollbar">
                {messages.map((m, i) => (
                  <div key={i} className={`m3-bubble ${m.role === 'user' ? 'bubble-user' : 'bubble-model'}`}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                  </div>
                ))}
                {isLoading && <div className="typing-dots"><div className="typing-dot" /><div className="typing-dot" /><div className="typing-dot" /></div>}
              </div>
              <div className="input-field-container">
                <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && sendMessage()} placeholder="Ask something..." />
                <button onClick={sendMessage} className="btn-send-m3"><Send size={16} /></button>
              </div>
            </motion.div>
          ) : activeTab === "voice" ? (
            <motion.div key="voice" className="p-6 h-full flex flex-col" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-black flex items-center gap-2"><BrainCircuit className="text-purple-400" /> Hints</h2>
                <div className="flex gap-2">
                  <div className={`p-1 px-3 rounded-lg text-[9px] uppercase font-black border tracking-wider ${userAmp > 300 ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-white/5 text-white/20 border-white/5'}`}>User</div>
                  <div className={`p-1 px-3 rounded-lg text-[9px] uppercase font-black border tracking-wider ${interAmp > 300 ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20' : 'bg-white/5 text-white/20 border-white/5'}`}>System</div>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto custom-scrollbar flex flex-col gap-4">
                {suggestions.length === 0 && <div className="flex-1 flex flex-col items-center justify-center opacity-10"><Volume2 size={40} /></div>}
                {suggestions.map((s, i) => (
                  <motion.div key={i} initial={{ x: -10, opacity: 0 }} animate={{ x: 0, opacity: 1 }} className="settings-card-m3 border-l-4 border-l-purple-500 p-4">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{s}</ReactMarkdown>
                  </motion.div>
                ))}
              </div>
            </motion.div>
          ) : (
            <motion.div key="settings" className="p-6 h-full overflow-y-auto custom-scrollbar" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <h2 className="text-xl font-black mb-6">Settings</h2>

              <div className="settings-card-m3">
                <span className="m3-label font-black text-purple-400">Selected AI Model</span>
                <div className="relative">
                  <select value={selectedModel} onChange={e => { setSelectedModel(e.target.value); saveSettings("selected_model", e.target.value); }} className="m3-input-text appearance-none pr-10">
                    {models.length > 0 ? (
                      models.map(m => <option key={m.name} value={m.name}>{m.displayName || m.name}</option>)
                    ) : (
                      <option value="models/gemini-1.5-flash">Gemini 1.5 Flash (Default)</option>
                    )}
                  </select>
                  <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                </div>
              </div>

              <div className="settings-card-m3">
                <span className="m3-label">API KEY</span>
                <div className="relative">
                  <input type={isKeyVisible ? "text" : "password"} value={apiKey} onChange={e => { setApiKey(e.target.value); saveSettings("api_key", e.target.value); }} className="m3-input-text pr-10" />
                  <button onClick={() => setIsKeyVisible(!isKeyVisible)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500">
                    {isKeyVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              <div className="settings-card-m3">
                <span className="m3-label">My Microphone</span>
                <select value={userDevice} onChange={e => { setUserDevice(e.target.value); saveSettings("user_device", e.target.value); }} className="m3-input-text">
                  <option value="">Default Input</option>
                  {devices.filter(d => d.is_input).map(d => <option key={d.name} value={d.name}>{d.name}</option>)}
                </select>
              </div>

              <div className="settings-card-m3">
                <span className="m3-label">Interviewer Source</span>
                <select value={interviewerDevice} onChange={e => { setInterviewerDevice(e.target.value); saveSettings("interviewer_device", e.target.value); }} className="m3-input-text">
                  <option value="">Default Output</option>
                  <optgroup label="Playback (Loopback)">
                    {devices.filter(d => !d.is_input).map(d => <option key={d.name} value={d.name}>{d.name}</option>)}
                  </optgroup>
                  <optgroup label="Direct Inputs">
                    {devices.filter(d => d.is_input).map(d => <option key={d.name} value={d.name}>{d.name}</option>)}
                  </optgroup>
                </select>
              </div>

              <div className="settings-card-m3 flex items-center justify-between">
                <div>
                  <div className="font-bold text-sm">Ghost Mode</div>
                  <div className="text-[10px] text-white/40">Protect window from sharing</div>
                </div>
                <div onClick={toggleProtection} className={`m3-toggle ${isProtected ? 'active' : ''}`}>
                  <div className="m3-toggle-ball" />
                </div>
              </div>

              <button onClick={refreshDevices} className="btn-refresh mt-4">
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
