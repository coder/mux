/**
 * Copy button handler for statically rendered code blocks
 * Attaches click handlers to pre-rendered buttons
 */

(function () {
  "use strict";

  // Initialize copy buttons after DOM loads
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initCopyButtons);
  } else {
    initCopyButtons();
  }

  function initCopyButtons() {
    document.querySelectorAll(".code-copy-button").forEach(function (button) {
      button.addEventListener("click", function () {
        var wrapper = button.closest(".code-block-wrapper");
        var code = wrapper.dataset.code;

        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard
            .writeText(code)
            .then(function () {
              showFeedback(button, true);
            })
            .catch(function (err) {
              console.warn("Failed to copy:", err);
              showFeedback(button, false);
            });
        } else {
          // Fallback for older browsers
          fallbackCopy(code);
          showFeedback(button, true);
        }
      });
    });
  }

  function showFeedback(button, success) {
    var originalContent = button.innerHTML;

    // Match the main app's CopyButton feedback - show "Copied!" text
    if (success) {
      button.innerHTML = '<span class="copy-feedback">Copied!</span>';
    } else {
      button.innerHTML = '<span class="copy-feedback">Failed!</span>';
    }
    button.disabled = true;

    setTimeout(function () {
      button.innerHTML = originalContent;
      button.disabled = false;
    }, 2000);
  }

  function fallbackCopy(text) {
    var textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  }
})();
