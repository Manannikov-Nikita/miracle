export interface MetadataSchema {
  catalog?: string;
  schema: string;
}

export interface MetadataColumn {
  table: string;
  name: string;
  type: string;
  position: number;
}

export interface MetadataPage<T> {
  items: T[];
  nextCursor?: string;
}
