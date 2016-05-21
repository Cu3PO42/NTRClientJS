"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});

function _asyncToGenerator(fn) { return function () { var gen = fn.apply(this, arguments); return new Promise(function (resolve, reject) { function step(key, arg) { try { var info = gen[key](arg); var value = info.value; } catch (error) { reject(error); return; } if (info.done) { resolve(value); } else { return Promise.resolve(value).then(function (value) { return step("next", value); }, function (err) { return step("throw", err); }); } } return step("next"); }); }; }

exports.default = (() => {
  var ref = _asyncToGenerator(function* (client, pid, value, locations) {
    if (locations !== undefined) {
      const res = [];

      for (const loc of locations) {
        const val = yield client.readMemory(loc, 4, pid);
        if (val.readUInt32LE(0) === value) {
          res.push(loc);
        }
      }

      return res;
    }

    const memorymap = yield client.getMemlayout(pid);
    const res = [];
    for (const region of memorymap) {
      console.log(`Scanning region from ${ region.start.toString(16) } to ${ region.end.toString(16) }`);
      const mem = yield client.readMemory(region.start, region.size, pid);
      for (let i = 0; i < mem.length; i += 4) {
        if (mem.readUInt32LE(i) === value) {
          res.push(region.start + i);
        }
      }
    }

    return res;
  });

  function search(_x, _x2, _x3, _x4) {
    return ref.apply(this, arguments);
  }

  return search;
})();