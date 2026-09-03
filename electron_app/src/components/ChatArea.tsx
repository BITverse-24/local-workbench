export default function ChatArea() {
  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-5" style={{ background: '#1A1A1A' }}>
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
    </div>
  );
}
