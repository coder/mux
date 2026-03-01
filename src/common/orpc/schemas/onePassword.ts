import { z } from "zod";

export const onePassword = {
  isAvailable: {
    output: z.object({ available: z.boolean() }),
  },
  listVaults: {
    output: z.array(z.object({ id: z.string(), title: z.string() })),
  },
  listItems: {
    input: z.object({ vaultId: z.string() }),
    output: z.array(z.object({ id: z.string(), title: z.string(), category: z.string() })),
  },
  getItemFields: {
    input: z.object({ vaultId: z.string(), itemId: z.string() }),
    output: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        sectionTitle: z.string().nullish(),
      })
    ),
  },
  buildReference: {
    input: z.object({
      vaultTitle: z.string(),
      itemTitle: z.string(),
      fieldTitle: z.string(),
      sectionTitle: z.string().nullish(),
    }),
    output: z.object({ reference: z.string() }),
  },
};
