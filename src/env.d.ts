// The Swift source of the audio tap is imported as text, so "bun build --compile" embeds it.
declare module "*.swift" {
  const source: string;
  export default source;
}
