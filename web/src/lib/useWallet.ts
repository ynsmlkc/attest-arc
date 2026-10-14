import { useCallback, useEffect, useState } from "react";
import { connectWallet, getAllowedAddress, onAccountsChanged } from "./wallet";

export function useWallet() {
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reload should not log the user out: pick an already-approved account back up.
  useEffect(() => {
    let cancelled = false;
    getAllowedAddress().then((addr) => {
      if (!cancelled && addr) setAddress((cur) => cur ?? addr);
    });
    const off = onAccountsChanged(setAddress);
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      setAddress(await connectWallet());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect wallet");
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => setAddress(null), []);

  return { address, connecting, error, connect, disconnect };
}
