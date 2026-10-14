export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancelled = () => { signal.removeEventListener('abort', cancelled); reject(signal.reason) }
    if (signal.aborted) cancelled()
    else signal.addEventListener('abort', cancelled, { once: true })
    void work.then((value) => { signal.removeEventListener('abort', cancelled); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', cancelled); reject(error) })
  })
}
