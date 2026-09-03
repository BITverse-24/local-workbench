import { useState } from 'react';
import './App.css';
import TitleBar from './components/TitleBar';
import LeftSidebar from './components/LeftSidebar';
import ChatPanel from './components/ChatPanel';
import ChatArea from './components/ChatArea';
import InputBar from './components/InputBar';
import RightSidebar from './components/RightSidebar';
import ModelDropdown from './components/ModelDropdown';
import PlusDropup from './components/PlusDropup';
import UploadModal from './components/modals/UploadModal';
import CameraModal from './components/modals/CameraModal';
import VoiceModal from './components/modals/VoiceModal';
import { MODELS } from './lib/models';
import { useDropdownPosition, usePlusPosition } from './lib/hooks/useDropdownPosition';
import { useCamera } from './lib/hooks/useCamera';
import { useVoice } from './lib/hooks/useVoice';
import { useUpload } from './lib/hooks/useUpload';

export default function App() {
  const [input, setInput] = useState('');
  const [temperature, setTemperature] = useState(0.7);
  const [selectedModel, setSelectedModel] = useState(MODELS[0]);
  const [modelOpen, setModelOpen] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [searchActive, setSearchActive] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  const { btnRef: modelBtnRef, pos: dropdownPos } = useDropdownPosition(modelOpen);
  const { btnRef: plusBtnRef, pos: plusPos } = usePlusPosition(plusOpen);

  const upload = useUpload();
  const camera = useCamera();
  const voice = useVoice();

  return (
    <div className="flex flex-col h-screen w-full font-sans overflow-hidden relative select-none page-apple-enter" style={{ background: '#181818' }}>
      <TitleBar />

      <div className="flex flex-1 overflow-hidden p-3 gap-3 relative z-10" style={{ background: '#181818' }}>
        <LeftSidebar collapsed={leftCollapsed} onCollapse={() => setLeftCollapsed(true)} />

        <ChatPanel leftCollapsed={leftCollapsed} rightCollapsed={rightCollapsed} onToggleLeft={() => setLeftCollapsed(!leftCollapsed)} onToggleRight={() => setRightCollapsed(!rightCollapsed)}>
          <ChatArea />
          <InputBar
            input={input}
            setInput={setInput}
            plusOpen={plusOpen}
            setPlusOpen={setPlusOpen}
            plusBtnRef={plusBtnRef}
            searchActive={searchActive}
            setSearchActive={setSearchActive}
            onVoice={() => voice.setShow(true)}
          />
        </ChatPanel>

        <RightSidebar
          collapsed={rightCollapsed}
          onCollapse={() => setRightCollapsed(true)}
          models={MODELS}
          selectedModel={selectedModel}
          modelOpen={modelOpen}
          setModelOpen={setModelOpen}
          modelBtnRef={modelBtnRef}
          temperature={temperature}
          setTemperature={setTemperature}
        />
      </div>

      <ModelDropdown open={modelOpen} pos={dropdownPos} models={MODELS} selected={selectedModel} onSelect={(m) => { setSelectedModel(m); setModelOpen(false); }} onClose={() => setModelOpen(false)} />

      <PlusDropup
        open={plusOpen}
        pos={plusPos}
        onClose={() => setPlusOpen(false)}
        onUpload={() => { setPlusOpen(false); upload.setShow(true); }}
        onCamera={() => { setPlusOpen(false); camera.setShow(true); }}
        onSearch={() => { setPlusOpen(false); setSearchActive(true); }}
      />

      <UploadModal open={upload.show} dragOver={upload.dragOver} setDragOver={upload.setDragOver} files={upload.files} setFiles={upload.setFiles} onClose={() => upload.setShow(false)} />

      <CameraModal open={camera.show} error={camera.error} capturedImage={camera.capturedImage} videoRef={camera.videoRef} canvasRef={camera.canvasRef} onClose={camera.close} onCapture={camera.capturePhoto} onRetake={() => camera.setCapturedImage(null)} />

      <VoiceModal
        open={voice.show}
        devices={voice.devices}
        selectedMicId={voice.selectedMicId}
        setSelectedMicId={voice.setSelectedMicId}
        isRecording={voice.isRecording}
        recTime={voice.recTime}
        recordedBlob={voice.recordedBlob}
        setRecordedBlob={voice.setRecordedBlob}
        error={voice.error}
        onClose={voice.close}
        onStart={voice.start}
        onStop={voice.stop}
      />
    </div>
  );
}
