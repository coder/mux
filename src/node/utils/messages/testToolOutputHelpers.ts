import { isToolContentResult } from "@/common/utils/tools/toolContentResult";

export function expectContentOutputValue(output: unknown): unknown[] {
  if (isToolContentResult(output)) {
    return output.value;
  }

  throw new Error("Expected rewritten content output");
}
