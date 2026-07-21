import { describe, expect, it } from 'vitest'
import { contains, mergeOverlapping, overlaps, subtract } from '../../src/worker/lib/intervals.ts'

describe('overlaps', () => {
  it('hai khoảng kề nhau không tính là chồng nhau', () => {
    // [0,10) và [10,20) chạm nhau ở đúng một điểm — nửa mở nên KHÔNG chồng.
    // Đây là chốt chặn cho lỗi mất một slot hợp lệ ở mỗi ranh giới.
    expect(overlaps({ start: 0, end: 10 }, { start: 10, end: 20 })).toBe(false)
    expect(overlaps({ start: 10, end: 20 }, { start: 0, end: 10 })).toBe(false)
  })

  it('hai khoảng giao nhau một phần thì chồng nhau', () => {
    expect(overlaps({ start: 0, end: 10 }, { start: 9, end: 20 })).toBe(true)
    expect(overlaps({ start: 9, end: 20 }, { start: 0, end: 10 })).toBe(true)
  })

  it('khoảng nằm trọn bên trong thì chồng nhau', () => {
    expect(overlaps({ start: 0, end: 100 }, { start: 40, end: 50 })).toBe(true)
  })

  it('hai khoảng rời hẳn nhau thì không chồng', () => {
    expect(overlaps({ start: 0, end: 10 }, { start: 11, end: 20 })).toBe(false)
  })
})

describe('contains', () => {
  it('block kết thúc đúng bằng biên vẫn nằm gọn bên trong', () => {
    // [0,30) chứa [10,30): nửa mở nên chạm biên phải vẫn là "vừa khít".
    expect(contains({ start: 0, end: 30 }, { start: 10, end: 30 })).toBe(true)
  })

  it('block tràn qua biên một đơn vị thì không nằm gọn', () => {
    expect(contains({ start: 0, end: 30 }, { start: 10, end: 31 })).toBe(false)
  })
})

describe('subtract', () => {
  it('subtract khoét lỗ giữa trả về hai khoảng', () => {
    expect(subtract({ start: 0, end: 100 }, [{ start: 40, end: 60 }])).toEqual([
      { start: 0, end: 40 },
      { start: 60, end: 100 },
    ])
  })

  it('subtract lỗ trùm hết trả về mảng rỗng', () => {
    expect(subtract({ start: 10, end: 90 }, [{ start: 0, end: 100 }])).toEqual([])
  })

  it('subtract lỗ trùng khít khoảng gốc trả về mảng rỗng', () => {
    expect(subtract({ start: 0, end: 100 }, [{ start: 0, end: 100 }])).toEqual([])
  })

  it('subtract lỗ nằm ngoài giữ nguyên khoảng gốc', () => {
    expect(subtract({ start: 0, end: 100 }, [{ start: 200, end: 300 }])).toEqual([
      { start: 0, end: 100 },
    ])
  })

  it('subtract lỗ chỉ kề biên (không chồng) giữ nguyên khoảng gốc', () => {
    // Lỗ [100,200) kề đúng biên phải và [-50,0) kề biên trái: nửa mở nên
    // không khoét mất gì cả.
    expect(subtract({ start: 0, end: 100 }, [{ start: 100, end: 200 }])).toEqual([
      { start: 0, end: 100 },
    ])
    expect(subtract({ start: 0, end: 100 }, [{ start: -50, end: 0 }])).toEqual([
      { start: 0, end: 100 },
    ])
  })

  it('subtract nhiều lỗ chồng nhau xử lý đúng', () => {
    // Ba lỗ chồng lên nhau ở giữa phải gộp thành một lỗ [20,70), không sinh
    // ra khoảng âm hay khoảng rỗng.
    expect(
      subtract({ start: 0, end: 100 }, [
        { start: 20, end: 50 },
        { start: 40, end: 70 },
        { start: 30, end: 45 },
      ]),
    ).toEqual([
      { start: 0, end: 20 },
      { start: 70, end: 100 },
    ])
  })

  it('subtract nhiều lỗ rời nhau trả về đúng các mảnh còn lại', () => {
    expect(
      subtract({ start: 0, end: 100 }, [
        { start: 60, end: 70 },
        { start: 20, end: 30 },
      ]),
    ).toEqual([
      { start: 0, end: 20 },
      { start: 30, end: 60 },
      { start: 70, end: 100 },
    ])
  })

  it('subtract lỗ cắt đầu và cuối chỉ còn khúc giữa', () => {
    expect(
      subtract({ start: 0, end: 100 }, [
        { start: -10, end: 25 },
        { start: 80, end: 120 },
      ]),
    ).toEqual([{ start: 25, end: 80 }])
  })

  it('subtract không sinh khoảng rỗng khi lỗ chạm sát nhau', () => {
    // Hai lỗ kề nhau [20,40) và [40,60) không được để lại khe rỗng [40,40).
    const res = subtract({ start: 0, end: 100 }, [
      { start: 20, end: 40 },
      { start: 40, end: 60 },
    ])
    expect(res).toEqual([
      { start: 0, end: 20 },
      { start: 60, end: 100 },
    ])
  })

  it('khoảng gốc rỗng luôn trả về mảng rỗng', () => {
    expect(subtract({ start: 50, end: 50 }, [])).toEqual([])
  })

  it('không có lỗ nào thì trả nguyên khoảng gốc', () => {
    expect(subtract({ start: 0, end: 100 }, [])).toEqual([{ start: 0, end: 100 }])
  })
})

describe('mergeOverlapping', () => {
  it('gộp các khoảng chồng nhau thành một', () => {
    expect(
      mergeOverlapping([
        { start: 0, end: 10 },
        { start: 5, end: 20 },
      ]),
    ).toEqual([{ start: 0, end: 20 }])
  })

  it('gộp cả khoảng kề nhau vì chúng phủ liên tục không có khe', () => {
    expect(
      mergeOverlapping([
        { start: 0, end: 10 },
        { start: 10, end: 20 },
      ]),
    ).toEqual([{ start: 0, end: 20 }])
  })

  it('giữ nguyên các khoảng rời nhau và sắp xếp tăng dần', () => {
    expect(
      mergeOverlapping([
        { start: 30, end: 40 },
        { start: 0, end: 10 },
      ]),
    ).toEqual([
      { start: 0, end: 10 },
      { start: 30, end: 40 },
    ])
  })

  it('khoảng nằm trọn bên trong không làm co khoảng bao ngoài', () => {
    expect(
      mergeOverlapping([
        { start: 0, end: 100 },
        { start: 20, end: 30 },
      ]),
    ).toEqual([{ start: 0, end: 100 }])
  })

  it('loại bỏ khoảng rỗng', () => {
    expect(
      mergeOverlapping([
        { start: 5, end: 5 },
        { start: 10, end: 20 },
      ]),
    ).toEqual([{ start: 10, end: 20 }])
  })
})
