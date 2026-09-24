import { useEffect, useRef } from "react";
import QRCode from "qrcode";

interface QRCodeCanvasProps {
  value: string;
  size?: number;
}

export default function QRCodeCanvas({ value, size = 180 }: QRCodeCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current || !value) return;
    QRCode.toCanvas(canvasRef.current, value, {
      width: size,
      margin: 2,
      color: {
        dark: "#e8f0fe",
        light: "#0d1117",
      },
    });
  }, [value, size]);

  return <canvas ref={canvasRef} width={size} height={size} className="rounded" />;
}
