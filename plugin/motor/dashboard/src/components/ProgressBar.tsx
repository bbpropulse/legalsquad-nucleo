interface ProgressBarProps {
  current: number;
  total: number;
}

// Thin visual progress bar for the pipeline (footer).
export function ProgressBar({ current, total }: ProgressBarProps) {
  const pct = total > 0 ? Math.min(100, Math.max(0, Math.round((current / total) * 100))) : 0;
  return (
    <div
      title={`${current}/${total}`}
      style={{
        width: 120,
        height: 6,
        borderRadius: 3,
        background: "var(--border)",
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          width: `${pct}%`,
          height: "100%",
          background: "var(--accent-green)",
          transition: "width 0.4s ease",
        }}
      />
    </div>
  );
}
