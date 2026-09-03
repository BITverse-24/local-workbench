import { useState, useRef } from 'react';

export function useUpload() {
  const [show, setShow] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const clear = () => { setFiles([]); setShow(false); };

  return { show, setShow, dragOver, setDragOver, files, setFiles, inputRef, clear };
}
