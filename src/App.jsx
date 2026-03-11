import { useState, useRef, useEffect, useCallback } from "react";

const STORAGE_KEY = "fleetmind-knowledge-base";

async function saveKnowledgeBase(manuals, knowledgeBase) {
  try {
    await window.storage.set(STORAGE_KEY, JSON.stringify({ manuals, knowledgeBase }), true);
  } catch (err) {
    console.error("Storage save failed:", err);
  }
}

async function loadKnowledgeBase() {
  try {
    const result = await window.storage.get(STORAGE_KEY, true);
    if (result?.value) return JSON.parse(result.value);
  } catch {}
  return null;
}

async function clearKnowledgeBase() {
  try {
    await window.storage.delete(STORAGE_KEY, true);
  } catch (err) {
    console.error("Storage clear failed:", err);
  }
}

const SYSTEM_PROMPT = `You are a lift equipment troubleshooting assistant for El Cheapo Lifts, helping technicians diagnose problems over the phone. Responses must be brief and spoken-word friendly — the tech is on a call, not reading a report.

STRICT FORMAT RULES:
- Start EVERY response with a severity tag on its own line — exactly one of:
  🟢 FIELD FIX — operator or tech can resolve on-site without special tools
  🟡 SCHEDULE SERVICE — needs a technician visit but machine can keep working
  🔴 DOWN MACHINE — unsafe to operate, dispatch immediately
- Maximum 3 sentences after the severity tag unless a numbered checklist is needed
- Lead immediately with the most likely cause — no preamble
- If steps are needed, use a short numbered list (max 5 steps), each one a single sentence
- One safety warning only if there is a genuine risk; skip it otherwise
- End with "Need more detail?" if the fix wasn't obvious — never pad the response

NEVER: use headers, bold text, long explanations, multiple causes at once, or disclaimers. If unsure, give the single most probable answer and ask one clarifying question.

If manual excerpts are in the context, use them silently to inform your answer — do not cite or reference them aloud.`;

const API_HEADERS = {
  "Content-Type": "application/json",
  "x-api-key": import.meta.env.VITE_ANTHROPIC_API_KEY,
  "anthropic-version": "2023-06-01",
  "anthropic-dangerous-direct-browser-access": "true",
};

function chunkText(text, chunkSize = 800, overlap = 150) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    start += chunkSize - overlap;
    if (start >= text.length) break;
  }
  return chunks;
}

function simpleEmbed(text) {
  const words = text.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/);
  const vocab = {};
  words.forEach(w => { vocab[w] = (vocab[w] || 0) + 1; });
  return vocab;
}

function sparseScore(queryVocab, chunkText) {
  const chunkVocab = simpleEmbed(chunkText);
  let score = 0;
  for (const [word, qCount] of Object.entries(queryVocab)) {
    if (chunkVocab[word]) score += Math.sqrt(qCount * chunkVocab[word]);
  }
  return score;
}

function retrieveChunks(query, knowledgeBase, topK = 4) {
  const queryVocab = simpleEmbed(query);
  return knowledgeBase
    .map(chunk => ({ ...chunk, score: sparseScore(queryVocab, chunk.text) }))
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

async function extractEquipmentInfo(text) {
  const sample = text.slice(0, 1500);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: API_HEADERS,
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: `From this equipment manual excerpt, extract the make (manufacturer) and model(s) covered. Return ONLY a JSON object like: {"make":"Caterpillar","models":["336","336 GC"]}. If multiple models are covered list them all. If you cannot determine make or model with confidence, use null.\n\nExcerpt:\n${sample}`
        }]
      }),
    });
    const data = await res.json();
    const raw = data.content?.map(b => b.text || "").join("") || "{}";
    const clean = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch {
    return { make: null, models: [] };
  }
}

async function callClaude(messages, systemPrompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: API_HEADERS,
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: systemPrompt,
      messages,
    }),
  });
  const data = await res.json();
  return data.content?.map(b => b.text || "").join("") || "No response received.";
}

async function extractTextFromFile(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "txt" || ext === "md") return await file.text();
  if (ext === "pdf") {
    const base64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result.split(",")[1]);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: API_HEADERS,
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
            { type: "text", text: "Extract ALL text content from this document. Return only the raw text, preserving section headers and structure. No commentary." }
          ]
        }]
      }),
    });
    const data = await response.json();
    return data.content?.map(b => b.text || "").join("") || "";
  }
  if (ext === "docx") {
    try {
      const { default: mammoth } = await import("mammoth");
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      return result.value;
    } catch {
      return await file.text().catch(() => "Could not parse DOCX file.");
    }
  }
  return await file.text().catch(() => `[Could not extract text from ${file.name}]`);
}

function normalizeUrl(raw) {
  let url = raw.trim();
  const gdrive = url.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  if (gdrive) return `https://drive.google.com/uc?export=download&id=${gdrive[1]}`;
  if (url.includes("dropbox.com")) return url.replace("www.dropbox.com", "dl.dropboxusercontent.com").replace("?dl=0", "").replace("?dl=1", "");
  if (!url.startsWith("http")) url = "https://" + url;
  return url;
}

async function extractTextFromUrl(rawUrl) {
  const url = normalizeUrl(rawUrl);
  const isPdf = url.split("?")[0].toLowerCase().endsWith(".pdf");
  const proxyUrl = `https://fleetmind-proxy.schusteralex2.workers.dev/proxy?url=${encodeURIComponent(url)}`;

  if (isPdf) {
    const resp = await fetch(proxyUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    const blob = await resp.blob();
    const base64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result.split(",")[1]);
      r.onerror = rej;
      r.readAsDataURL(blob);
    });
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: API_HEADERS,
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
            { type: "text", text: "Extract ALL text content from this document. Return only the raw text, preserving section headers and structure. No commentary." }
          ]
        }]
      }),
    });
    const data = await response.json();
    return data.content?.map(b => b.text || "").join("") || "";
  }

  const resp = await fetch(proxyUrl);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  const html = await resp.text();
  const plain = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .slice(0, 8000);
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: API_HEADERS,
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: `This is text extracted from an equipment documentation web page. Extract only the meaningful technical content (specs, procedures, troubleshooting steps, part names). Discard navigation, ads, and boilerplate. Return plain text only.\n\n${plain}`
      }]
    }),
  });
  const data = await response.json();
  return data.content?.map(b => b.text || "").join("") || "";
}

function FleetCoverage({ manuals }) {
  const byMake = {};
  manuals.forEach(m => {
    const make = m.make || "Unknown";
    if (!byMake[make]) byMake[make] = [];
    (m.models?.length ? m.models : ["(model unknown)"]).forEach(model => {
      if (!byMake[make].includes(model)) byMake[make].push(model);
    });
  });
  const makes = Object.keys(byMake).sort();
  if (makes.length === 0) return null;
  return (
    <div className="fleet-coverage">
      <div className="fleet-coverage-title">Fleet Coverage</div>
      {makes.map(make => (
        <div key={make} className="fleet-make-group">
          <div className="fleet-make-name">{make}</div>
          <div className="fleet-models">
            {byMake[make].map(model => (
              <span key={model} className="fleet-model-tag">{model}</span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function UrlImport({ onUrlImport, isProcessing }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const handleSubmit = () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    try { new URL(trimmed.startsWith("http") ? trimmed : "https://" + trimmed); }
    catch { setError("Please enter a valid URL"); return; }
    setError("");
    onUrlImport(trimmed);
    setUrl("");
  };
  return (
    <div className="url-import">
      <div className="url-import-label">Import from URL</div>
      <div className="url-import-row">
        <input className="url-input" placeholder="Paste PDF or page URL..." value={url}
          onChange={e => { setUrl(e.target.value); setError(""); }}
          onKeyDown={e => e.key === "Enter" && handleSubmit()} disabled={isProcessing} />
        <button className="url-import-btn" onClick={handleSubmit} disabled={!url.trim() || isProcessing}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
        </button>
      </div>
      {error && <div className="url-error">{error}</div>}
      <div className="url-hint">Supports: direct PDF links, Google Drive, Dropbox, public doc pages</div>
    </div>
  );
}

function UploadZone({ onFilesProcessed, isProcessing }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef();
  const handleFiles = useCallback(async (files) => { onFilesProcessed(Array.from(files)); }, [onFilesProcessed]);
  return (
    <div className={`upload-zone ${dragging ? "dragging" : ""} ${isProcessing ? "processing" : ""}`}
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
      onClick={() => !isProcessing && inputRef.current?.click()}>
      <input ref={inputRef} type="file" multiple accept=".pdf,.docx,.txt,.md"
        style={{ display: "none" }} onChange={e => handleFiles(e.target.files)} />
      <div className="upload-icon">
        {isProcessing ? (
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
          </svg>
        ) : (
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="12" y1="18" x2="12" y2="12"/>
            <line x1="9" y1="15" x2="15" y2="15"/>
          </svg>
        )}
      </div>
      <p className="upload-title">{isProcessing ? "Processing manuals..." : "Upload Equipment Manuals"}</p>
      <p className="upload-sub">PDF · DOCX · TXT · MD — drag & drop or click</p>
    </div>
  );
}

function ManualBadge({ manual, onRemove, onUpdateInfo }) {
  const icons = { pdf: "📄", docx: "📝", txt: "📃", md: "📃" };
  const ext = manual.name.split(".").pop().toLowerCase();
  const needsInfo = !manual.make || !manual.models?.length;
  const [editing, setEditing] = useState(needsInfo);
  const [makeVal, setMakeVal] = useState(manual.make || "");
  const [modelVal, setModelVal] = useState(manual.models?.join(", ") || "");
  const handleSave = () => {
    onUpdateInfo(manual.id, {
      make: makeVal.trim() || null,
      models: modelVal.trim() ? modelVal.split(",").map(s => s.trim()).filter(Boolean) : [],
    });
    setEditing(false);
  };
  return (
    <div className="manual-badge" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span>{icons[ext] || "📁"}</span>
        <span className="badge-name">{manual.name}</span>
        <span className="badge-chunks">{manual.chunks} chunks</span>
        {!editing && <button onClick={() => setEditing(true)} className="badge-edit" title="Edit make/model">✏️</button>}
        <button onClick={() => onRemove(manual.id)} className="badge-remove">×</button>
      </div>
      {editing && (
        <div className="badge-edit-row">
          <input className="badge-input" placeholder="Make (e.g. Skyjack)" value={makeVal} onChange={e => setMakeVal(e.target.value)} />
          <input className="badge-input" placeholder="Model(s) e.g. SJ3220" value={modelVal} onChange={e => setModelVal(e.target.value)} />
          <button className="badge-save-btn" onClick={handleSave}>Save</button>
        </div>
      )}
    </div>
  );
}

function Message({ msg }) {
  const isUser = msg.role === "user";
  return (
    <div className={`message ${isUser ? "user" : "assistant"}`}>
      <div className="msg-avatar">{isUser ? "🔧" : "⚡"}</div>
      <div className="msg-content">
        {msg.sources?.length > 0 && (
          <div className="msg-sources">
            {msg.sources.map((s, i) => <span key={i} className="source-tag">📄 {s}</span>)}
          </div>
        )}
        <div className="msg-text" dangerouslySetInnerHTML={{ __html: formatMessage(msg.content) }} />
      </div>
    </div>
  );
}

function formatMessage(text) {
  return text
    .replace(/^🟢 FIELD FIX(.*)$/m, "<div class='triage triage-green'>🟢 FIELD FIX$1</div>")
    .replace(/^🟡 SCHEDULE SERVICE(.*)$/m, "<div class='triage triage-yellow'>🟡 SCHEDULE SERVICE$1</div>")
    .replace(/^🔴 DOWN MACHINE(.*)$/m, "<div class='triage triage-red'>🔴 DOWN MACHINE$1</div>")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/^#{1,3} (.+)$/gm, "<h4>$1</h4>")
    .replace(/^(\d+\.) (.+)$/gm, "<div class='numbered-item'><span>$1</span> $2</div>")
    .replace(/^[•\-] (.+)$/gm, "<div class='bullet-item'>• $1</div>")
    .replace(/⚠️(.*?)(\n|$)/g, "<div class='warning-line'>⚠️$1</div>")
    .replace(/\n\n/g, "<br/><br/>")
    .replace(/\n/g, "<br/>");
}

export default function ConstructionChatbot() {
  const [manuals, setManuals] = useState([]);
  const [knowledgeBase, setKnowledgeBase] = useState([]);
  const [messages, setMessages] = useState([{
    role: "assistant",
    content: "Hello! I'm the El Cheapo Lifts tech support assistant. Upload your equipment manuals using the panel on the left, then describe any issue and I'll help diagnose it.",
  }]);
  const [input, setInput] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [processingFile, setProcessingFile] = useState("");
  const [storageStatus, setStorageStatus] = useState("loading");
  const [selectedEquipment, setSelectedEquipment] = useState("all");
  const chatEndRef = useRef();

  useEffect(() => {
    (async () => {
      const saved = await loadKnowledgeBase();
      if (saved?.manuals?.length > 0) {
        setManuals(saved.manuals);
        setKnowledgeBase(saved.knowledgeBase);
        setStorageStatus("ready");
        setMessages([{
          role: "assistant",
          content: `✅ Loaded **${saved.manuals.length} manual${saved.manuals.length > 1 ? "s" : ""}** from shared storage (${saved.knowledgeBase.length} chunks): ${saved.manuals.map(m => m.name).join(", ")}.\n\nDescribe any equipment issue and I'll help troubleshoot it.`,
        }]);
      } else {
        setStorageStatus("empty");
      }
    })();
  }, []);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, isThinking]);

  const handleFilesProcessed = async (files) => {
    setIsProcessing(true);
    const newChunks = [];
    const newManuals = [];
    for (const file of files) {
      setProcessingFile(file.name);
      try {
        const text = await extractTextFromFile(file);
        const chunks = chunkText(text);
        const manualId = `${file.name}-${Date.now()}`;
        chunks.forEach((chunkText, i) => {
          newChunks.push({ id: `${manualId}-${i}`, manualId, manualName: file.name, text: chunkText });
        });
        const equipInfo = await extractEquipmentInfo(text);
        newManuals.push({ id: manualId, name: file.name, chunks: chunks.length, make: equipInfo.make, models: equipInfo.models || [] });
      } catch (err) {
        console.error("Error processing", file.name, err);
      }
    }
    const updatedManuals = [...manuals, ...newManuals];
    const updatedKB = [...knowledgeBase, ...newChunks];
    setKnowledgeBase(updatedKB);
    setManuals(updatedManuals);
    setIsProcessing(false);
    setProcessingFile("");
    setStorageStatus("ready");
    await saveKnowledgeBase(updatedManuals, updatedKB);
    if (newManuals.length > 0) {
      setMessages(prev => [...prev, {
        role: "assistant",
        content: `✅ Indexed **${newManuals.map(m => m.name).join(", ")}** — ${newChunks.length} chunks saved to shared storage. All technicians now have access.`,
      }]);
    }
  };

  const handleUrlImport = async (rawUrl) => {
    setIsProcessing(true);
    const label = rawUrl.length > 50 ? rawUrl.slice(0, 47) + "..." : rawUrl;
    setProcessingFile(label);
    try {
      const text = await extractTextFromUrl(rawUrl);
      if (!text.trim()) throw new Error("No content extracted");
      const chunks = chunkText(text);
      const manualId = `url-${Date.now()}`;
      const newChunks = chunks.map((t, i) => ({ id: `${manualId}-${i}`, manualId, manualName: label, text: t }));
      const equipInfo = await extractEquipmentInfo(text);
      const newManual = { id: manualId, name: label, chunks: chunks.length, make: equipInfo.make, models: equipInfo.models || [], source: "url", url: rawUrl };
      const updatedManuals = [...manuals, newManual];
      const updatedKB = [...knowledgeBase, ...newChunks];
      setManuals(updatedManuals);
      setKnowledgeBase(updatedKB);
      setStorageStatus("ready");
      await saveKnowledgeBase(updatedManuals, updatedKB);
      setMessages(prev => [...prev, { role: "assistant", content: `✅ Imported and indexed content from URL — ${chunks.length} chunks saved to shared storage.` }]);
    } catch (err) {
      setMessages(prev => [...prev, { role: "assistant", content: `❌ Could not import from that URL: ${err.message}. Try downloading the PDF and uploading it directly.` }]);
    }
    setIsProcessing(false);
    setProcessingFile("");
  };

  const removeManual = async (manualId) => {
    const updatedManuals = manuals.filter(m => m.id !== manualId);
    const updatedKB = knowledgeBase.filter(c => c.manualId !== manualId);
    setManuals(updatedManuals);
    setKnowledgeBase(updatedKB);
    if (updatedManuals.length === 0) { await clearKnowledgeBase(); setStorageStatus("empty"); }
    else await saveKnowledgeBase(updatedManuals, updatedKB);
  };

  const updateManualInfo = async (manualId, { make, models }) => {
    const updatedManuals = manuals.map(m => m.id === manualId ? { ...m, make, models } : m);
    setManuals(updatedManuals);
    await saveKnowledgeBase(updatedManuals, knowledgeBase);
  };

  const sendMessage = async () => {
    if (!input.trim() || isThinking) return;
    const userMsg = input.trim();
    setInput("");
    setMessages(prev => [...prev, { role: "user", content: userMsg }]);
    setIsThinking(true);

    const activeKB = selectedEquipment === "all"
      ? knowledgeBase
      : knowledgeBase.filter(c => {
          const m = manuals.find(m => m.id === c.manualId);
          return m && (m.make + " " + (m.models || []).join(" ")).toLowerCase().includes(selectedEquipment.toLowerCase());
        });
    const relevantChunks = retrieveChunks(userMsg, activeKB, 4);
    const sources = [...new Set(relevantChunks.map(c => c.manualName))];

    let contextBlock = "";
    if (relevantChunks.length > 0) {
      contextBlock = "\n\n--- RELEVANT MANUAL EXCERPTS ---\n" +
        relevantChunks.map(c => `[From: ${c.manualName}]\n${c.text}`).join("\n\n---\n") +
        "\n--- END OF EXCERPTS ---\n\n";
    } else if (knowledgeBase.length === 0) {
      contextBlock = "\n\n[No manuals uploaded yet. Responding from general knowledge.]\n\n";
    }

    const history = messages.filter(m => m.role !== "assistant" || messages.indexOf(m) > 0).slice(-8).map(m => ({ role: m.role, content: m.content }));
    const equipLabel = selectedEquipment === "all"
      ? ""
      : (() => { const m = manuals.find(m => m.id === selectedEquipment); return m ? `Equipment: ${m.make || ""} ${(m.models || []).join(", ")} — ` : ""; })();
    const augmentedUserMsg = contextBlock + equipLabel + "Technician's issue: " + userMsg;
    const claudeMessages = [...history, { role: "user", content: augmentedUserMsg }];

    try {
      const reply = await callClaude(claudeMessages, SYSTEM_PROMPT);
      setMessages(prev => [...prev, { role: "assistant", content: reply, sources: sources.length > 0 ? sources : undefined }]);
    } catch (err) {
      setMessages(prev => [...prev, { role: "assistant", content: "Sorry, I encountered an error connecting to the AI. Please check your connection and try again." }]);
    }
    setIsThinking(false);
  };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Black+Han+Sans&family=Roboto+Condensed:wght@400;500;700&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        :root {
          --yellow: #FFD000; --yellow-dim: #ccaa00; --black: #111111;
          --dark: #181818; --darker: #101010; --surface: #1e1e1e;
          --surface2: #252525; --border: #2e2e2e; --text: #e8e8e8;
          --green: #4ade80; --red: #f87171;
        }
        body { font-family: 'Roboto Condensed', sans-serif; background: var(--darker); color: var(--text); height: 100vh; overflow: hidden; }
        .app { display: grid; grid-template-columns: 300px 1fr; grid-template-rows: 60px 1fr; height: 100vh; background: var(--darker); }
        .header { grid-column: 1 / -1; background: var(--black); border-bottom: 3px solid var(--yellow); display: flex; align-items: center; padding: 0 20px; gap: 14px; }
        .header-logo-wrap { display: flex; align-items: center; gap: 10px; }
        .header-bolt { font-size: 22px; line-height: 1; filter: drop-shadow(0 0 6px #FFD00088); }
        .header-brand { display: flex; flex-direction: column; line-height: 1.1; }
        .header-name { font-family: 'Black Han Sans', sans-serif; font-size: 17px; color: var(--yellow); letter-spacing: 0.04em; text-transform: uppercase; }
        .header-tagline { font-size: 9px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: #555; }
        .header-divider { width: 1px; height: 28px; background: #2e2e2e; }
        .header-sub { font-size: 12px; color: #555; letter-spacing: 0.03em; font-weight: 500; }
        .kb-pill { margin-left: auto; background: #1a1a1a; border: 1px solid #2e2e2e; border-radius: 20px; padding: 3px 12px; font-size: 11px; font-weight: 700; letter-spacing: 0.03em; }
        .sidebar { background: var(--dark); border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }
        .sidebar-title { padding: 12px 14px; font-size: 10px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #555; border-bottom: 1px solid var(--border); }
        .manuals-list { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 6px; }
        .manuals-list::-webkit-scrollbar { width: 4px; }
        .manuals-list::-webkit-scrollbar-thumb { background: #333; border-radius: 4px; }
        .no-manuals { text-align: center; padding: 24px 12px; color: #444; font-size: 13px; line-height: 1.6; }
        .upload-area { padding: 12px; border-top: 1px solid var(--border); }
        .upload-zone { border: 1.5px dashed #333; border-radius: 8px; padding: 20px 12px; text-align: center; cursor: pointer; transition: all 0.2s; background: var(--darker); }
        .upload-zone:hover, .upload-zone.dragging { border-color: var(--yellow); background: #1a1600; }
        .upload-zone.processing { cursor: wait; opacity: 0.7; }
        .upload-zone.processing svg { animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .upload-icon { color: var(--yellow); margin-bottom: 8px; }
        .upload-title { font-size: 13px; font-weight: 600; color: var(--text); }
        .upload-sub { font-size: 11px; color: #555; margin-top: 4px; }
        .fleet-coverage { padding: 10px 12px 4px; border-bottom: 1px solid var(--border); }
        .fleet-coverage-title { font-size: 10px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: #555; margin-bottom: 8px; }
        .fleet-make-group { margin-bottom: 8px; }
        .fleet-make-name { font-size: 11px; font-weight: 700; color: var(--yellow); letter-spacing: 0.03em; margin-bottom: 4px; text-transform: uppercase; }
        .fleet-models { display: flex; flex-wrap: wrap; gap: 4px; }
        .fleet-model-tag { font-size: 11px; background: var(--surface); border: 1px solid var(--border); color: #aaa; border-radius: 4px; padding: 2px 7px; }
        .badge-edit { background: none; border: none; cursor: pointer; font-size: 12px; padding: 0; opacity: 0.5; margin-left: auto; }
        .badge-edit:hover { opacity: 1; }
        .badge-edit-row { display: flex; gap: 4px; flex-wrap: wrap; }
        .badge-input { flex: 1; min-width: 80px; background: var(--darker); border: 1px solid #2e2e2e; border-radius: 4px; padding: 4px 7px; font-size: 11px; color: var(--text); font-family: 'Roboto Condensed', sans-serif; outline: none; }
        .badge-input:focus { border-color: #FFD00055; }
        .badge-input::placeholder { color: #444; }
        .badge-save-btn { background: var(--yellow); border: none; border-radius: 4px; padding: 4px 10px; font-size: 11px; font-weight: 700; color: #111; cursor: pointer; font-family: 'Roboto Condensed', sans-serif; }
        .badge-save-btn:hover { background: var(--yellow-dim); }
        .manual-badge { display: flex; align-items: center; gap: 6px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 7px 10px; font-size: 12px; }
        .badge-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #ccc; }
        .badge-chunks { color: #4ade80; font-size: 10px; background: #0a1a08; border-radius: 4px; padding: 1px 5px; white-space: nowrap; }
        .badge-remove { background: none; border: none; color: #555; cursor: pointer; font-size: 16px; line-height: 1; padding: 0; margin-left: 2px; }
        .badge-remove:hover { color: #ef4444; }
        .equip-selector-wrap { padding: 10px 14px; border-bottom: 1px solid var(--border); }
        .equip-selector-label { font-size: 10px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #555; margin-bottom: 5px; }
        .equip-selector { width: 100%; background: var(--darker); border: 1px solid #2e2e2e; border-radius: 5px; padding: 5px 8px; font-size: 12px; color: var(--text); font-family: 'Roboto Condensed', sans-serif; outline: none; cursor: pointer; }
        .equip-selector:focus { border-color: #FFD00055; }
        .chat-area { display: flex; flex-direction: column; overflow: hidden; }
        .messages { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 16px; }
        .messages::-webkit-scrollbar { width: 4px; }
        .messages::-webkit-scrollbar-thumb { background: #333; border-radius: 4px; }
        .message { display: flex; gap: 12px; max-width: 820px; }
        .message.user { align-self: flex-end; flex-direction: row-reverse; }
        .message.user .msg-content { background: #1a2030; border: 1px solid #2a3555; border-radius: 16px 4px 16px 16px; }
        .message.assistant .msg-content { background: var(--surface); border: 1px solid var(--border); border-radius: 4px 16px 16px 16px; }
        .msg-avatar { width: 32px; height: 32px; border-radius: 50%; background: var(--surface2); display: flex; align-items: center; justify-content: center; font-size: 16px; flex-shrink: 0; margin-top: 2px; }
        .msg-content { padding: 12px 16px; max-width: 680px; }
        .msg-sources { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
        .source-tag { font-size: 10px; background: #0f1f0a; border: 1px solid #1a3015; color: #4ade80; border-radius: 4px; padding: 2px 6px; }
        .msg-text { font-size: 14px; line-height: 1.65; color: var(--text); }
        .msg-text h4 { font-family: 'Black Han Sans', sans-serif; font-size: 14px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--yellow); margin: 10px 0 4px; }
        .msg-text strong { color: #eee; }
        .msg-text .numbered-item { display: flex; gap: 8px; margin: 4px 0; padding-left: 4px; }
        .msg-text .numbered-item span:first-child { color: var(--yellow); font-weight: 700; min-width: 20px; }
        .msg-text .bullet-item { padding: 2px 0 2px 8px; }
        .msg-text .warning-line { background: #1a1500; border-left: 3px solid var(--yellow); padding: 6px 10px; margin: 6px 0; border-radius: 0 4px 4px 0; color: var(--yellow-dim); font-size: 13px; }
        .triage { display: inline-block; font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; padding: 4px 12px; border-radius: 4px; margin-bottom: 10px; }
        .triage-green { background: #0a2010; color: var(--green); border: 1px solid #1a4020; }
        .triage-yellow { background: #1a1500; color: var(--yellow); border: 1px solid #3a3000; }
        .triage-red { background: #200a0a; color: var(--red); border: 1px solid #401515; }
        .thinking { display: flex; gap: 12px; max-width: 820px; }
        .thinking-dots { display: flex; gap: 5px; align-items: center; padding: 12px 16px; background: var(--surface); border: 1px solid var(--border); border-radius: 4px 16px 16px 16px; }
        .thinking-dots span { width: 6px; height: 6px; background: var(--yellow); border-radius: 50%; animation: bounce 1.2s ease-in-out infinite; }
        .thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
        .thinking-dots span:nth-child(3) { animation-delay: 0.4s; }
        @keyframes bounce { 0%, 80%, 100% { transform: translateY(0); opacity: 0.4; } 40% { transform: translateY(-5px); opacity: 1; } }
        .input-area { padding: 16px 20px; border-top: 1px solid var(--border); background: var(--dark); }
        .input-row { display: flex; gap: 10px; align-items: flex-end; background: var(--darker); border: 1.5px solid var(--border); border-radius: 12px; padding: 10px 14px; transition: border-color 0.2s; }
        .input-row:focus-within { border-color: #FFD00055; }
        textarea { flex: 1; background: none; border: none; outline: none; resize: none; font-family: 'Roboto Condensed', sans-serif; font-size: 14px; color: var(--text); line-height: 1.5; min-height: 22px; max-height: 120px; }
        textarea::placeholder { color: #444; }
        .send-btn { background: var(--yellow); border: none; border-radius: 8px; width: 36px; height: 36px; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: all 0.15s; }
        .send-btn:hover { background: var(--yellow-dim); transform: scale(1.05); }
        .send-btn:disabled { background: #2a2a2a; cursor: not-allowed; transform: none; }
        .send-btn svg { color: #111; }
        .input-hint { text-align: center; font-size: 11px; color: #333; margin-top: 8px; }
        .url-import { padding: 10px 12px 8px; border-top: 1px solid var(--border); }
        .url-import-label { font-size: 10px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: #555; margin-bottom: 6px; }
        .url-import-row { display: flex; gap: 6px; }
        .url-input { flex: 1; background: var(--darker); border: 1px solid #2e2e2e; border-radius: 6px; padding: 6px 9px; font-size: 11px; color: var(--text); font-family: 'Roboto Condensed', sans-serif; outline: none; min-width: 0; }
        .url-input:focus { border-color: #FFD00055; }
        .url-input::placeholder { color: #444; }
        .url-input:disabled { opacity: 0.5; }
        .url-import-btn { background: var(--surface2); border: 1px solid #2e2e2e; border-radius: 6px; width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--yellow); flex-shrink: 0; transition: all 0.15s; }
        .url-import-btn:hover { background: var(--yellow); color: #111; }
        .url-import-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .url-error { font-size: 10px; color: #ef4444; margin-top: 4px; }
        .url-hint { font-size: 10px; color: #444; margin-top: 5px; line-height: 1.4; }
        .processing-banner { background: #1a1500; border-bottom: 1px solid #FFD00033; padding: 6px 16px; font-size: 12px; color: var(--yellow); text-align: center; animation: pulse 1.5s ease-in-out infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
      `}</style>

      <div className="app">
        <header className="header">
          <div className="header-logo-wrap">
            <span className="header-bolt">⚡</span>
            <div className="header-brand">
              <span className="header-name">El Cheapo Lifts</span>
              <span className="header-tagline">Equipment Troubleshooting</span>
            </div>
          </div>
          <div className="header-divider" />
          <span className="header-sub">Tech Support Assistant</span>
          <span className="kb-pill" style={{ color: knowledgeBase.length > 0 ? "#4ade80" : "#555" }}>
            {knowledgeBase.length > 0 ? `${knowledgeBase.length} chunks indexed` : "No manuals loaded"}
          </span>
        </header>

        <aside className="sidebar">
          <div className="sidebar-title" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>Equipment Manuals</span>
            <span style={{
              fontSize: 10, fontWeight: 600, letterSpacing: "0.05em", padding: "2px 7px", borderRadius: 4,
              background: storageStatus === "loading" ? "#1a1a1a" : storageStatus === "ready" ? "#0a2010" : "#1a1200",
              color: storageStatus === "loading" ? "#555" : storageStatus === "ready" ? "#4ade80" : "#FFD000",
              border: `1px solid ${storageStatus === "ready" ? "#2a4020" : storageStatus === "loading" ? "#2e2e2e" : "#FFD00033"}`,
            }}>
              {storageStatus === "loading" ? "⏳ LOADING" : storageStatus === "ready" ? "☁ SYNCED" : "○ EMPTY"}
            </span>
          </div>
          <FleetCoverage manuals={manuals} />
          {manuals.length > 0 && (
            <div className="equip-selector-wrap">
              <div className="equip-selector-label">Active Equipment</div>
              <select className="equip-selector" value={selectedEquipment} onChange={e => setSelectedEquipment(e.target.value)}>
                <option value="all">All Equipment</option>
                {manuals.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.make ? `${m.make}${m.models?.length ? " — " + m.models.join(", ") : ""}` : m.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="manuals-list">
            {manuals.length === 0 ? (
              <div className="no-manuals">Upload equipment manuals to enable manual-referenced troubleshooting</div>
            ) : (
              manuals.map(m => <ManualBadge key={m.id} manual={m} onRemove={removeManual} onUpdateInfo={updateManualInfo} />)
            )}
          </div>
          <div className="upload-area">
            {isProcessing && processingFile && (
              <div style={{ fontSize: 11, color: "#FFD000", textAlign: "center", marginBottom: 8 }}>
                Indexing: {processingFile}
              </div>
            )}
            <UrlImport onUrlImport={handleUrlImport} isProcessing={isProcessing} />
            <UploadZone onFilesProcessed={handleFilesProcessed} isProcessing={isProcessing} />
          </div>
        </aside>

        <main className="chat-area">
          {isProcessing && <div className="processing-banner">Extracting and indexing manual content... this may take a moment for large PDFs</div>}
          <div className="messages">
            {messages.map((msg, i) => <Message key={i} msg={msg} />)}
            {isThinking && (
              <div className="thinking">
                <div className="msg-avatar">⚡</div>
                <div className="thinking-dots"><span /><span /><span /></div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
          <div className="input-area">
            <div className="input-row">
              <textarea value={input}
                onChange={e => { setInput(e.target.value); e.target.style.height = "22px"; e.target.style.height = e.target.scrollHeight + "px"; }}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                placeholder="Describe the issue — e.g. 'Won't elevate, pump running but no movement...'"
                rows={1} />
              <button className="send-btn" onClick={sendMessage} disabled={!input.trim() || isThinking}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="22" y1="2" x2="11" y2="13"/>
                  <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                </svg>
              </button>
            </div>
            <div className="input-hint">Shift+Enter for new line · Enter to send</div>
          </div>
        </main>
      </div>
    </>
  );
}
