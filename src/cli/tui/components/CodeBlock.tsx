import { Box, Text } from "ink";

interface CodeBlockProps {
  code: string;
  language?: string;
}

function getLanguageLabel(language?: string): string | null {
  const normalized = language?.trim();
  if (!normalized) {
    return null;
  }

  const [firstToken] = normalized.split(/\s+/);
  return firstToken?.trim().length ? firstToken.trim() : null;
}

export function CodeBlock(props: CodeBlockProps) {
  const languageLabel = getLanguageLabel(props.language);
  const code = props.code.trimEnd();

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      {languageLabel ? <Text dimColor>{`─── ${languageLabel} ───`}</Text> : null}
      <Box borderStyle="round" borderColor="gray" paddingLeft={1} paddingRight={1}>
        <Text color="white">{code.length > 0 ? code : " "}</Text>
      </Box>
    </Box>
  );
}
