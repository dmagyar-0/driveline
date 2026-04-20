# The Driveline Book

A guided, code-first walkthrough of the Driveline codebase written for
readers who have **not** used Rust, TypeScript, or React before.

Every chapter picks one real file (or small cluster of files) from this
repository, quotes a short snippet, and explains what each line is doing
and *why* it looks the way it does. By the end you should be able to open
any file in `apps/web/` or `crates/` and have a rough idea of what is
happening.

## Chapters

1. [What Driveline Is and Why It Exists](./01-what-driveline-is.md)
2. [Three Languages, One App](./02-three-languages.md)
3. [A Tour of the Repository](./03-repo-tour.md)
4. [The Rust Core — Types and the `Reader` Trait](./04-rust-core.md)
5. [WASM — Carrying Rust Into the Browser](./05-wasm-bridge.md)
6. [The React UI and the Zustand Store](./06-react-and-store.md)
7. [Web Workers, Comlink, and Parallelism](./07-workers-and-comlink.md)
8. [Data on the Wire — Arrow IPC and Encoded Chunks](./08-wire-formats.md)
9. [The Video Pipeline — WebCodecs, End to End](./09-video-pipeline.md)
10. [Timeline, Cursor, and Playback](./10-timeline-and-playback.md)
11. [Running, Testing, and Shipping](./11-run-test-ship.md)

## How to read the book

Read top to bottom on the first pass. Chapter 2 pays off the whole rest
of the book — don't skip it even if you think you already know React. The
chapters are short (15–25 minutes each) and there are no exercises; just
follow along with the files open in your editor.

When a chapter quotes code, the file path and line numbers are given so
you can jump to the original. Types and function names are linked the
first time they appear. Jargon is defined in the [glossary in the main
docs README](../README.md#glossary).

## What this book assumes

- You can read *some* programming language fluently (any one of C, C++,
  Java, Python, Go, C#, Kotlin, Swift, or JavaScript is enough).
- You have a terminal, Git, and a text editor.
- You are comfortable with the idea of a "compiler" and a "package
  manager" in the abstract, even if the specifics here are new.

You do **not** need prior exposure to:

- Rust, its ownership model, `cargo`, or `wasm-bindgen`.
- TypeScript or the JavaScript module system.
- React, hooks, or any specific state-management library.
- WebAssembly, Web Workers, WebCodecs, or Apache Arrow.

Each of these shows up in its own chapter with a "what even is this?"
introduction before any code.
