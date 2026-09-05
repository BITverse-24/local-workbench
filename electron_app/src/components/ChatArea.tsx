export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  files?: File[];
};

type Props = {
  messages?: ChatMessage[];
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileLabel(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (['pdf'].includes(ext)) return 'PDF';
  if (['doc', 'docx'].includes(ext)) return 'DOC';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'SHEET';
  if (['ppt', 'pptx'].includes(ext)) return 'SLIDES';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'heic'].includes(ext)) return 'IMAGE';
  return ext ? ext.toUpperCase() : 'FILE';
}

export default function ChatArea({ messages = [] }: Props) {
  const hasMessages = messages.length > 0;

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-5" style={{ background: '#1A1A1A' }}>
      {!hasMessages ? (
        <>
          <div className="flex justify-end animate-apple-message">
            <div className="px-5 py-3.5 rounded-[18px] rounded-br-[6px] max-w-[88%] md:max-w-[72%] neu-raised">
              <p className="text-sm leading-relaxed">Hello, how are you?</p>
            </div>
          </div>
          <div className="flex justify-start animate-apple-message delay-100">
            <div className="px-5 py-3.5 rounded-[18px] rounded-bl-[6px] max-w-[88%] md:max-w-[72%] neu-card">
              <p className="text-sm leading-relaxed">I&apos;m doing well, thank you! How can I help you today? I&apos;m running fully air-gapped — no external egress.</p>
              <div className="flex items-center gap-2 mt-3"></div>
            </div>
          </div>
          <div className="flex justify-start animate-apple-message delay-200">
            <div className="w-full max-w-[88%] md:max-w-[78%] rounded-2xl neu-card p-3 flex items-center gap-3">
              <div className="w-8 h-8 rounded-xl neu-pressed grid place-items-center text-xs">◐</div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium">OCR extraction complete</div>
                <div className="text-xs opacity-50 truncate">5 findings • page-ref validated • ready for retrieval</div>
              </div>
              <span className="text-xs px-3 py-1.5 neu-button-primary font-medium shrink-0">View</span>
            </div>
          </div>
        </>
      ) : null}

      {messages.map((msg) => (
        <div key={msg.id} className={`flex animate-apple-message ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
          <div
            className={`px-5 py-3.5 rounded-[18px] max-w-[88%] md:max-w-[72%] ${msg.role === 'user' ? 'rounded-br-[6px] neu-raised' : 'rounded-bl-[6px] neu-card'}`}
          >
            {msg.text && <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{msg.text}</p>}
            {msg.files && msg.files.length > 0 && (
              <div className={`flex flex-wrap gap-2 ${msg.text ? 'mt-3' : ''}`}>
                {msg.files.map((f, i) => (
                  <span
                    key={`${f.name}-${i}`}
                    className="inline-flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-full neu-pressed text-xs max-w-[200px]"
                  >
                    <span className="w-6 h-6 rounded-full bg-white/10 grid place-items-center text-[8px] font-bold shrink-0">{fileLabel(f.name).slice(0, 3)}</span>
                    <span className="truncate font-medium">{f.name}</span>
                    <span className="opacity-50 shrink-0">{formatSize(f.size)}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
