import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';

interface Props {
  onScan: (data: string) => void;
  onClose: () => void;
}

export function QrScanner({ onScan, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        if (stopped) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play();
        scan();
      } catch {
        setError('카메라에 접근할 수 없습니다.');
      }
    }

    function scan() {
      if (stopped) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < 2) {
        rafRef.current = requestAnimationFrame(scan);
        return;
      }

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(video, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height);

      if (code?.data) {
        // Lightning invoice QR은 보통 "lightning:" prefix가 붙는다
        const raw = code.data.replace(/^lightning:/i, '').trim();
        onScan(raw);
        return;
      }
      rafRef.current = requestAnimationFrame(scan);
    }

    start();

    return () => {
      stopped = true;
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, [onScan]);

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.container} onClick={e => e.stopPropagation()}>
        {error ? (
          <p style={styles.error}>{error}</p>
        ) : (
          <video ref={videoRef} style={styles.video} playsInline muted />
        )}
        <canvas ref={canvasRef} style={{ display: 'none' }} />
        <button style={styles.closeBtn} onClick={onClose}>닫기</button>
      </div>
    </div>
  );
}

const styles = {
  overlay: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.7)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  container: {
    background: '#000',
    borderRadius: 12,
    overflow: 'hidden' as const,
    maxWidth: 360,
    width: '90%',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 8,
    padding: '8px 8px 12px',
  },
  video: {
    width: '100%',
    borderRadius: 8,
  },
  error: {
    color: '#EF4444',
    fontSize: 14,
    padding: '24px 16px',
    textAlign: 'center' as const,
  },
  closeBtn: {
    background: 'none',
    border: '1px solid rgba(255,255,255,0.3)',
    color: '#fff',
    padding: '6px 20px',
    borderRadius: 6,
    fontSize: 13,
    cursor: 'pointer',
  },
};
