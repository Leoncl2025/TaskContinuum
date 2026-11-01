export default function afterPack(context: {
  appOutDir: string
  packager: { config: { forceCodeSigning?: boolean; win?: { signtoolOptions?: { publisherName?: string } } } }
}): Promise<void>
