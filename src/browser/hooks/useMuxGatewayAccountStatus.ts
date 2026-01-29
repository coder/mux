import { useCallback, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { formatCostWithDollar } from "@/common/utils/tokens/usageAggregator";

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

  const refresh = useCallback(async () => {
    if (!api) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await api.muxGateway.getAccountStatus();
      if (result.success) {
        setData(result.data);
        return;
      }

      setError(result.error);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [api]);

  return { data, error, isLoading, refresh };
}
