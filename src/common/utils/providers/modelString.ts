export function modelStringStartsWithProvider(
  modelString: string | undefined,
  provider: string
): boolean {
  return modelString?.startsWith(`${provider}:`) ?? false;
}
