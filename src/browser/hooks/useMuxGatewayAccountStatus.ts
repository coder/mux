import { useCallback, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { MUX_GATEWAY_SESSION_EXPIRED_MESSAGE } from "@/common/constants/muxGatewayOAuth";
import { formatCostWithDollar } from "@/common/utils/tokens/usageAggregator";
import { getErrorMessage } from "@/common/utils/errors";

export interface MuxGatewayAccountStatus {
  remaining_microdollars: number;
  ai_gateway_concurrent_requests_per_user: number;
}

export function formatMuxGatewayBalance(remainingMicrodollars: number | null | undefined): string {
  if (remainingMicrodollars === null || remainingMicrodollars === undefined) {
    return "—";
  }

  return formatCostWithDollar(remainingMicrodollars / 1_000_000);
}

export function useMuxGatewayAccountStatus() {
  const { api } = useAPI();
  const [data, setData] = useState<MuxGatewayAccountStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async (): Promise<MuxGatewayAccountStatus | null> => {
    if (!api) {
      return null;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await api.muxGateway.getAccountStatus();
      if (result.success) {
        setData(result.data);
        return result.data;
      }

      if (result.error === MUX_GATEWAY_SESSION_EXPIRED_MESSAGE) {
        // Dispatch session-expired event; useGateway() listens for it and
        // optimistically marks the gateway as unconfigured to stop routing.
        window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.MUX_GATEWAY_SESSION_EXPIRED));

        setData(null);
        setError(null);
        return null;
      }

      setError(result.error);
      return null;
    } catch (err) {
      const message = getErrorMessage(err);
      setError(message);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [api]);

  return { data, error, isLoading, refresh };
}
