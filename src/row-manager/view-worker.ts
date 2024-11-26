import { ComputeViewDoneEvent, Rows, View } from './row-manager'
import { Row } from '../row'
import { sort as timSort } from './timsort'
import { Result } from '../utils/result'
import { wait } from '../utils/wait'
import { isEmptyFast } from '../utils/is-empty-fast'
console.log('Worker initialized')

export default class ViewWorker {
  private rowData: Rows = []
  private currentFilterId: [number] = [0]
  private cache = {
    sort: null as Row[] | null,
    sortKey: null as string | null,
  }

  constructor() {
    self.addEventListener('message', (event: Message) => {
      this.handleEvent(event)
    })
  }

  private letOtherEventsThrough = () => wait(0)

  private async filterRows({
    filter,
    rowsArr,
    buffer,
    shouldCancel,
    onEarlyResults,
  }: {
    filter: View['filter']
    rowsArr: Row[]
    buffer: Int32Array
    shouldCancel: () => boolean
    onEarlyResults: (numRows: number) => void
  }): Promise<Result<{ numRows: number }>> {
    const lowerCaseFilter: Record<number, string> = Object.fromEntries(
      Object.entries(filter).map(([k, v]) => [k, v.toLowerCase()])
    )

    const MIN_RESULTS_EARLY_RESULT = 50
    const ROW_CHUNK_SIZE = 30000

    const numChunks = Math.ceil(rowsArr.length / ROW_CHUNK_SIZE)
    let sentEarlyResults = false
    let offset = 0

    for (let chunkIndex = 0; chunkIndex < numChunks; chunkIndex++) {
      const startIndex = chunkIndex * ROW_CHUNK_SIZE
      const endIndex = Math.min(startIndex + ROW_CHUNK_SIZE, rowsArr.length)

      await this.letOtherEventsThrough()
      if (shouldCancel()) {
        return { ok: false, error: 'filter-cancelled' }
      }

      if (
        !sentEarlyResults &&
        offset > MIN_RESULTS_EARLY_RESULT &&
        rowsArr.length > 70000 &&
        startIndex > 30000
      ) {
        // makes filtering look super fast
        onEarlyResults(offset)
        sentEarlyResults = true
      }

      for (let i = startIndex; i < endIndex; i++) {
        const row = rowsArr[i]!
        let matchesFilter = true

        for (const column in lowerCaseFilter) {
          if (
            String(row.cells[column].v)
              .toLowerCase()
              .indexOf(lowerCaseFilter[column]) === -1
          ) {
            matchesFilter = false
            break
          }
        }

        if (matchesFilter) {
          Atomics.store(buffer, offset, row.id)
          offset += 1
        }
      }
    }
    return { ok: true, value: { numRows: offset } }
  }

  private getSortComparisonFn(
    config: ['ascending' | 'descending' | null, number][]
  ) {
    return (a: Row, b: Row) => {
      for (let col = 0; col < config.length; col++) {
        const [direction, colIndex] = config[col]
        if (direction === null) {
          continue
        }
        if (direction === 'ascending') {
          if (a.cells[colIndex].v > b.cells[colIndex].v) {
            return 1
          } else if (a.cells[colIndex].v < b.cells[colIndex].v) {
            return -1
          }
        }
        if (a.cells[colIndex].v < b.cells[colIndex].v) {
          return 1
        } else if (a.cells[colIndex].v > b.cells[colIndex].v) {
          return -1
        }
      }
      return 0
    }
  }

  private async computeView({
    rows,
    buffer,
    viewConfig,
    shouldCancel,
  }: {
    rows: Rows
    buffer: Int32Array
    viewConfig: View
    shouldCancel: () => boolean
  }): Promise<number | 'cancelled'> {
    const sortConfig = viewConfig.sort

    let rowsArr = rows

    const sortKey = JSON.stringify(sortConfig)
    if (sortKey === this.cache.sortKey) {
      rowsArr = this.cache.sort ?? rows
    } else if (!isEmptyFast(sortConfig)) {
      rowsArr = [...rows] // todo: can use a global array reference here and manually check if all references are the same still

      const start = performance.now()
      const sortResult = await timSort(
        rowsArr,
        this.getSortComparisonFn(
          sortConfig.map((c) => [c.direction, c.column])
        ),
        shouldCancel
      )
      if (!sortResult.ok) {
        return 'cancelled'
      }
      console.log('sorting took', performance.now() - start)

      this.cache.sort = rowsArr
      this.cache.sortKey = sortKey
    }

    await this.letOtherEventsThrough()
    if (shouldCancel()) {
      return 'cancelled'
    }

    if (isEmptyFast(viewConfig.filter)) {
      const start = performance.now()
      for (let i = 0; i < rowsArr.length; i++) {
        Atomics.store(buffer, i, rowsArr[i]!.id)
      }
      console.log(
        'returning early after sort, wrote buffer ms:',
        performance.now() - start
      )
      return rowsArr.length
    }

    const start = performance.now()
    const result = await this.filterRows({
      filter: viewConfig.filter,
      buffer,
      rowsArr,
      onEarlyResults: (numRows: number) => {
        console.log('early results', numRows)
        self.postMessage({
          type: 'compute-view-done',
          numRows,
          skipRefreshThumb: true,
        } satisfies ComputeViewDoneEvent)
      },
      shouldCancel,
    })

    await this.letOtherEventsThrough()
    if (shouldCancel() || !result.ok) {
      return 'cancelled'
    }

    console.log(
      'filtering happened, num rows:',
      result.value.numRows,
      'ms:',
      performance.now() - start
    )
    return result.value.numRows
  }

  private async handleEvent(event: Message) {
    const message = event.data
    switch (message.type) {
      case 'compute-view': {
        this.currentFilterId[0] = message.viewConfig.version
        const shouldCancel = () => {
          if (message.viewConfig.version !== this.currentFilterId[0]) {
            console.log(
              'cancelled computation of view',
              message.viewConfig.version,
              this.currentFilterId[0]
            )
          }
          return message.viewConfig.version !== this.currentFilterId[0]
        }
        const numRows = await this.computeView({
          viewConfig: message.viewConfig,
          buffer: message.viewBuffer,
          rows: this.rowData,
          shouldCancel,
        })

        // NOTE: let other events stream through & check if any of them invalidates this one
        await this.letOtherEventsThrough()
        if (shouldCancel() || numRows === 'cancelled') {
          console.error('cancelled')
          self.postMessage({ type: 'compute-view-cancelled' })
          return
        }

        self.postMessage({ type: 'compute-view-done', numRows })
        return
      }
      case 'set-rows': {
        this.rowData = message.rows
        this.cache.sort = null
        return
      }
    }
  }
}

export type ComputeViewEvent = {
  type: 'compute-view'
  viewBuffer: Int32Array
  viewConfig: View
}

export type SetRowsEvent = {
  type: 'set-rows'
  rows: Rows
}

export type Message = MessageEvent<ComputeViewEvent | SetRowsEvent>
