/**
 * Server-Side Rendered Code Block Component
 * Used by mdbook-shiki preprocessor to generate static HTML
 * Reuses CopyIcon and styles from main app to ensure consistency
 */

import React from "react";
import { CopyIcon } from "../icons/CopyIcon";

interface CodeBlockSSRProps {
  code: string;
  highlightedLines: string[];
}

export function CodeBlockSSR({ code, highlightedLines }: CodeBlockSSRProps) {
  return (
    <div className="code-block-wrapper" data-code={code}>
      <div className="code-block-container">
        {highlightedLines.map((lineHtml, idx) => (
          <React.Fragment key={idx}>
            <div className="line-number">{idx + 1}</div>
            <div className="code-line" dangerouslySetInnerHTML={{ __html: lineHtml }} />
          </React.Fragment>
        ))}
      </div>
      <button className="copy-button code-copy-button" aria-label="Copy to clipboard">
        <CopyIcon className="copy-icon" />
      </button>
    </div>
  );
}
