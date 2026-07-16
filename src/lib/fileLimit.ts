// Maximum size allowed for a single uploaded file.
export const MAX_FILE_MB = 10
export const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024

// Returns a human-readable error message if the file is too large, else null.
export function fileTooLargeMessage(file: File): string | null {
  if (file.size > MAX_FILE_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1)
    return `"${file.name}" pesa ${mb} MB. El máximo permitido es ${MAX_FILE_MB} MB por archivo.`
  }
  return null
}
