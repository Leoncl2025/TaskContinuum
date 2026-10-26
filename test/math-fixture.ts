export const bm25Formula = String.raw`\text{score}(D,Q)=\sum_{q\in Q}\text{IDF}(q)\cdot
\frac{f(q,D)(k_1+1)}
{f(q,D)+k_1\left(1-b+b\frac{|D|}{\text{avgdl}}\right)}`

export const bm25Markdown = String.raw`## BM25

\[
${bm25Formula}
\]

| Symbol | Meaning |
| --- | --- |
| \(Q\) | Query terms |
| \(D\) | Document |
| \(f(q,D)\) | Term frequency |
| \(\text{IDF}(q)\) | Inverse document frequency |
| \(|D|\) | Document length |
| \(\text{avgdl}\) | Average document length |
| \(k_1\) | Term saturation |
| \(b\) | Length normalization |
`
