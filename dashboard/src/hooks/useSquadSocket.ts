import { useEffect, useRef } from "react";
import { useSquadStore } from "@/store/useSquadStore";
import { createSocketDispatcher } from "@/lib/socketDispatch";
import type { WsMessage } from "@/types/state";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const WS_FAIL_THRESHOLD = 3;
const POLL_INTERVAL_MS = 3000;

export function useSquadSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const setConnected = useSquadStore((s) => s.setConnected);
  const setSnapshot = useSquadStore((s) => s.setSnapshot);
  const updateSquadState = useSquadStore((s) => s.updateSquadState);
  const setSquadInvalid = useSquadStore((s) => s.setSquadInvalid);
  const setSquadInactive = useSquadStore((s) => s.setSquadInactive);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectDelay = RECONNECT_BASE_MS;
    let wsFailCount = 0;

    // Todo o protocolo (SNAPSHOT/UPDATE/INVALID/FINISHED/INACTIVE, incluindo o
    // relógio de exibição do desfecho e seus cancelamentos) vive em
    // lib/socketDispatch.ts — testável em node puro por tests/dashboard.test.js,
    // sem React nem WebSocket. Aqui fica só o transporte: WS com reconexão e o
    // polling de fallback.
    const dispatcher = createSocketDispatcher({
      setSnapshot,
      updateSquadState,
      setSquadInvalid,
      setSquadInactive,
      // Leituras do estado ATUAL da store — o cinto-e-suspensório do relógio de
      // exibição compara contra elas no disparo, não no armamento.
      getSquadState: (squad) => useSquadStore.getState().activeStates.get(squad),
      isSquadInvalid: (squad) => useSquadStore.getState().invalidStates.has(squad),
    });

    // ── HTTP polling fallback ───────────────────────────────────────────

    function stopPolling() {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    }

    function startPolling() {
      stopPolling();

      const poll = async () => {
        if (disposed) return;
        try {
          const res = await fetch("/api/snapshot", { cache: "no-store" });
          if (!res.ok || disposed) return;
          const msg: WsMessage = await res.json();
          dispatcher.dispatch(msg);
          setConnected(true);
        } catch {
          // Endpoint not available — will retry on next interval
        }
      };

      poll();
      pollTimerRef.current = setInterval(poll, POLL_INTERVAL_MS);
    }

    // ── WebSocket connection ────────────────────────────────────────────

    function connect() {
      if (disposed) return;

      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(
        `${protocol}//${window.location.host}/__squads_ws`,
      );
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) { ws.close(); return; }
        setConnected(true);
        reconnectDelay = RECONNECT_BASE_MS;
        wsFailCount = 0;
        stopPolling();
      };

      ws.onmessage = (event) => {
        if (disposed) return;
        try {
          const msg: WsMessage = JSON.parse(event.data);
          dispatcher.dispatch(msg);
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        if (disposed) return;

        setConnected(false);
        wsFailCount++;

        if (wsFailCount >= WS_FAIL_THRESHOLD) {
          startPolling();
        }

        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
          connect();
        }, reconnectDelay);
      };

      ws.onerror = () => {
        // onerror is always followed by onclose — just let onclose handle it.
        // Don't call ws.close() here to avoid "closed before established" in StrictMode.
      };
    }

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      dispatcher.dispose();
      stopPolling();
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [setConnected, setSnapshot, updateSquadState, setSquadInvalid, setSquadInactive]);
}
