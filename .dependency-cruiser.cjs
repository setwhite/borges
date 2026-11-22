const path = require("node:path");

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-deep-import-across-slices",
      comment:
        "Cross-slice imports must go through each vertical slice public index.ts seam.",
      severity: "error",
      from: {
        path: "^apps/server/src/(ingestion|indexing|retrieval|agent|interfaces)/",
      },
      to: {
        path: "^apps/server/src/(ingestion|indexing|retrieval|agent|interfaces)/.+",
        pathNot: [
          "^apps/server/src/$1/",
          "^apps/server/src/(ingestion|indexing|retrieval|agent|interfaces)/index\\.ts$",
        ],
      },
    },
    {
      name: "interfaces-no-direct-storage-or-indexing",
      comment:
        "Interfaces shell must call domain slice seams, never storage or indexing directly.",
      severity: "error",
      from: {
        path: "^apps/server/src/interfaces/",
      },
      to: {
        path: "^apps/server/src/(storage|indexing)/",
      },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    tsConfig: {
      fileName: path.resolve(__dirname, "apps/server/tsconfig.json"),
    },
  },
};
