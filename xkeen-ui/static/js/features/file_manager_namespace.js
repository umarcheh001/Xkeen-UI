let fileManagerApiRoot = null;

function createFileManagerApiRoot() {
  return {};
}

export function getFileManagerApiRoot() {
  if (!fileManagerApiRoot) {
    fileManagerApiRoot = createFileManagerApiRoot();
  }
  return fileManagerApiRoot;
}

export function getFileManagerNamespace() {
  return getFileManagerApiRoot();
}
