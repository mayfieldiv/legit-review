import { describe, expect, test } from 'bun:test';

import { buildCodeViewData } from '../app/_components/codeViewDataAccumulator';

const PATCH_TEXT = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 const stay = true;
-const oldValue = 1;
+const newValue = 2;
+const extra = 3;
 export const done = true;
diff --git a/docs/new.md b/docs/new.md
new file mode 100644
--- /dev/null
+++ b/docs/new.md
@@ -0,0 +1,2 @@
+hello
+world
`;

describe('buildCodeViewData', () => {
  test('records per-file line stats for file tree decorations', () => {
    const loadedData = buildCodeViewData(PATCH_TEXT, 'test-patch');

    expect(loadedData.treeSource.fileStatsByPath.get('src/app.ts')).toEqual({
      addedLines: 2,
      deletedLines: 1,
    });
    expect(loadedData.treeSource.fileStatsByPath.get('docs/new.md')).toEqual({
      addedLines: 2,
      deletedLines: 0,
    });
    expect(loadedData.diffStats).toMatchObject({
      addedLines: 4,
      deletedLines: 1,
      fileCount: 2,
    });
  });
});
