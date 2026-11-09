import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// The home-screen icon, drawn from the same shapes as app/icon.svg.
const AppleIcon = () =>
  new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        background: "#0f172a",
        borderRadius: 40,
        position: "relative",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 36,
          top: 39,
          width: 107,
          height: 27,
          borderRadius: 7,
          background: "#fff",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 75,
          top: 66,
          width: 29,
          height: 76,
          borderRadius: 7,
          background: "#fff",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 115,
          top: 115,
          width: 27,
          height: 27,
          borderRadius: 7,
          background: "#0ea5e9",
        }}
      />
    </div>,
    size
  );

export default AppleIcon;
