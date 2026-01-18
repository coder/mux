export function buildAskUserQuestionSummary(answers: Record<string, string>): string {
  const pairs = Object.entries(answers)
    .map(([question, answer]) => `"${question}"="${answer}"`)
    .join(", ");

  return pairs.length > 0
    ? `User has answered your questions: ${pairs}. You can now continue with the user's answers in mind.`
    : "User has answered your questions. You can now continue with the user's answers in mind.";
}
