import { z } from "zod";

export const getViewedSplashScreens = {
  input: z.undefined(),
  output: z.array(z.string()),
};

export const markSplashScreenViewed = {
  input: z.object({
    splashId: z.string(),
  }),
  output: z.undefined(),
};
