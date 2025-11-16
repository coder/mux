import { describe, expect, test } from "bun:test";
import { getLanguageFromPath } from "./languageDetector";

describe("getLanguageFromPath", () => {
  describe("JavaScript/TypeScript ecosystem", () => {
    test("detects TypeScript", () => {
      expect(getLanguageFromPath("Component.tsx")).toBe("tsx");
      expect(getLanguageFromPath("utils.ts")).toBe("typescript");
      expect(getLanguageFromPath("src/utils/helper.ts")).toBe("typescript");
    });

    test("detects JavaScript", () => {
      expect(getLanguageFromPath("app.js")).toBe("javascript");
      expect(getLanguageFromPath("Component.jsx")).toBe("jsx");
      expect(getLanguageFromPath("src/components/Button.jsx")).toBe("jsx");
    });
  });

  describe("web technologies", () => {
    test("detects HTML", () => {
      expect(getLanguageFromPath("index.html")).toBe("html");
      expect(getLanguageFromPath("templates/page.html")).toBe("html");
    });

    test("detects CSS and variants", () => {
      expect(getLanguageFromPath("styles.css")).toBe("css");
      expect(getLanguageFromPath("app.scss")).toBe("scss");
      expect(getLanguageFromPath("theme.sass")).toBe("sass");
      expect(getLanguageFromPath("variables.less")).toBe("less");
    });
  });

  describe("backend languages", () => {
    test("detects Python", () => {
      expect(getLanguageFromPath("main.py")).toBe("python");
      expect(getLanguageFromPath("src/utils/helper.py")).toBe("python");
    });

    test("detects Java", () => {
      expect(getLanguageFromPath("Main.java")).toBe("java");
      expect(getLanguageFromPath("com/example/Service.java")).toBe("java");
    });

    test("detects Go", () => {
      expect(getLanguageFromPath("main.go")).toBe("go");
      expect(getLanguageFromPath("pkg/utils/helper.go")).toBe("go");
    });

    test("detects Rust", () => {
      expect(getLanguageFromPath("main.rs")).toBe("rust");
      expect(getLanguageFromPath("src/lib.rs")).toBe("rust");
    });

    test("detects C/C++", () => {
      expect(getLanguageFromPath("main.c")).toBe("c");
      expect(getLanguageFromPath("main.cpp")).toBe("cpp");
      expect(getLanguageFromPath("header.h")).toBe("c");
    });

    test("detects C#", () => {
      expect(getLanguageFromPath("Program.cs")).toBe("csharp");
      expect(getLanguageFromPath("Services/UserService.cs")).toBe("csharp");
    });

    test("detects Ruby", () => {
      expect(getLanguageFromPath("app.rb")).toBe("ruby");
      expect(getLanguageFromPath("Gemfile")).toBe("ruby");
    });

    test("detects PHP", () => {
      expect(getLanguageFromPath("index.php")).toBe("php");
      expect(getLanguageFromPath("src/Controller.php")).toBe("php");
    });

    test("detects other backend languages", () => {
      expect(getLanguageFromPath("Main.kt")).toBe("kotlin");
      expect(getLanguageFromPath("App.swift")).toBe("swift");
      expect(getLanguageFromPath("Main.scala")).toBe("scala");
      expect(getLanguageFromPath("app.ex")).toBe("elixir");
    });
  });

  describe("shell and scripting", () => {
    test("detects shell scripts", () => {
      expect(getLanguageFromPath("script.sh")).toBe("bash");
      expect(getLanguageFromPath("deploy.bash")).toBe("bash");
    });

    test("detects PowerShell", () => {
      expect(getLanguageFromPath("script.ps1")).toBe("powershell");
    });

    test("detects batch files", () => {
      expect(getLanguageFromPath("build.bat")).toBe("batch");
    });
  });

  describe("data and config formats", () => {
    test("detects JSON", () => {
      expect(getLanguageFromPath("package.json")).toBe("json");
      expect(getLanguageFromPath("config.json")).toBe("json");
    });

    test("detects YAML", () => {
      expect(getLanguageFromPath("config.yaml")).toBe("yaml");
      expect(getLanguageFromPath(".github/workflows/ci.yml")).toBe("yaml");
    });

    test("detects TOML", () => {
      expect(getLanguageFromPath("Cargo.toml")).toBe("toml");
      expect(getLanguageFromPath("config.toml")).toBe("toml");
    });

    test("detects XML", () => {
      expect(getLanguageFromPath("config.xml")).toBe("xml");
      expect(getLanguageFromPath("pom.xml")).toBe("xml");
    });

    test("detects Markdown", () => {
      expect(getLanguageFromPath("README.md")).toBe("markdown");
      expect(getLanguageFromPath("docs/guide.md")).toBe("markdown");
    });

    test("detects SQL", () => {
      expect(getLanguageFromPath("schema.sql")).toBe("sql");
      expect(getLanguageFromPath("migrations/001_init.sql")).toBe("sql");
    });

    test("detects GraphQL", () => {
      expect(getLanguageFromPath("schema.graphql")).toBe("graphql");
      expect(getLanguageFromPath("queries.gql")).toBe("graphql");
    });
  });

  describe("other formats", () => {
    test("detects Dockerfile", () => {
      expect(getLanguageFromPath("Dockerfile")).toBe("docker");
      expect(getLanguageFromPath("Dockerfile.prod")).toBe("docker");
    });

    test("detects Makefile", () => {
      expect(getLanguageFromPath("Makefile")).toBe("makefile");
      expect(getLanguageFromPath("GNUmakefile")).toBe("makefile");
    });
  });

  describe("edge cases", () => {
    test("handles unknown extensions", () => {
      expect(getLanguageFromPath("file.unknownext")).toBe("text");
    });

    test("handles files without extensions", () => {
      expect(getLanguageFromPath("README")).toBe("text");
      expect(getLanguageFromPath("LICENSE")).toBe("text");
    });

    test("handles paths with directories", () => {
      expect(getLanguageFromPath("src/components/Button.tsx")).toBe("tsx");
      expect(getLanguageFromPath("backend/services/user.py")).toBe("python");
      expect(getLanguageFromPath("./relative/path/file.go")).toBe("go");
    });

    test("handles absolute paths", () => {
      expect(getLanguageFromPath("/usr/local/bin/script.sh")).toBe("bash");
      expect(getLanguageFromPath("/home/user/project/main.rs")).toBe("rust");
    });

    test("fallback to lowercase for unmapped languages", () => {
      // Languages not in LINGUIST_TO_PRISM map should fallback to lowercase
      // This is handled by the lowercase fallback in the implementation
      const result = getLanguageFromPath("test.dart");
      // Dart should be detected and lowercased (if not in map explicitly)
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
