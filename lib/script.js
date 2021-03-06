var javaAppContext = null;
var sleepingThreads = {};
var nativeFunctions = {};
var hooks = {};
var onLoads = [];

var gettid = getNativeFunction(findExport('gettid'), 'int', []);

function log(what) {
    send('0:::' + what);
}

function sendInfos(ctx) {
    var data = {
        "context": ctx,
        "tid": gettid()
    };
    if (typeof ctx['pc'] !== 'undefined') {
        data['symbol'] = DebugSymbol.fromAddress(ctx['pc']);
    } else {
        data['pid'] = Process.id;
        data['arch'] = Process.arch;
        data["modules"] = Process.enumerateModulesSync('---');
        data["ranges"] = Process.enumerateRangesSync('---');
    }

    send('1:::' + JSON.stringify(data));
}

function onHook(p, context) {
    if (hooks[p] !== null && typeof(hooks['p']) !== 'undefined') {
        if (hooks[p]['c'] !== null) {
            try {
                var res = eval(hooks[p]['c']);
                if (res !== null && typeof(res) === 'boolean') {
                    if (!res) {
                        return;
                    }
                }
            } catch (e) {}
        }

        if (hooks[p]['l'] !== null) {
            try {
                console.log(hooks[p]['l']);
                var res = hooks[p]['l']();
                console.log(res);
                if (res !== null && res < 0) {
                    return;
                }
            } catch (e) {}
        }
    }

    sendInfos(context);
    sleepingThreads[gettid()] = true;
    while (sleepingThreads[gettid()]) {
        Thread.sleep(1);
    }
}

function getNativeFunction(pt, ret, args) {
    var f = nativeFunctions[pt];
    if (typeof f !== 'undefined') {
        return f;
    }
    f = new NativeFunction(pt, ret, args);
    nativeFunctions[pt] = f;
    return f;
}

function findExport(name, module) {
    if (typeof module === 'undefined') {
        module = 'libc.so'
    }
    return Module.findExportByName(module, name);
}

var symb = Module.enumerateSymbolsSync("linker");
var phdr_tgds_ptr = 0;
var do_dlopen_ptr = 0;
for (var sym in symb) {
    if (symb[sym].name.indexOf("phdr_table_get_dynamic_section") >= 0) {
        phdr_tgds_ptr = symb[sym].address
    } else if(symb[sym].name.indexOf('do_dlopen') >= 0) {
        do_dlopen_ptr = symb[sym].address;
    }
    if (phdr_tgds_ptr > 0 && do_dlopen_ptr > 0) {
        break;
    }
}
if (phdr_tgds_ptr > 0 && do_dlopen_ptr > 0) {
    var phdr_tgds = getNativeFunction(phdr_tgds_ptr, 'void', ['pointer', 'int', 'pointer', 'pointer', 'pointer']);
    var hooked_onload = null;
    Interceptor.replace(phdr_tgds_ptr, new NativeCallback(function (a, b, c, d, e) {
        if (hooked_onload !== null) {
            send("2:::" + hooked_onload + ':::' + c + ':::' + gettid());
            hooked_onload = null;
            onHook(this.context.pc, this.context);
        }
        return phdr_tgds(a, b, c, d, e);
    }, 'void', ['pointer', 'int', 'pointer', 'pointer', 'pointer']));
    Interceptor.attach(do_dlopen_ptr, function (args) {
        try {
            var w = Memory.readCString(args[0]);
            for (var s in onLoads) {
                if (w.indexOf(onLoads[s]) >= 0) {
                    hooked_onload = onLoads[s];
                }
            }
        } catch (e) {}
    });
}

Java.perform(function () {
    var Application = Java.use('android.app.Application');
    Application.onCreate.overload().implementation = function () {
        javaAppContext = this;
        sendInfos({});
        sleepingThreads[gettid()] = true;
        while (sleepingThreads[gettid()]) {
            Thread.sleep(1);
        }
        return this.onCreate();
    };
});

rpc.exports = {
    addvar: function(w) {
        try {
            var v = eval(w);
            var k = 2;
            if (v instanceof NativePointer) {
                k = 0;
            } else if (typeof(v) === 'string') {
                k = 1
            }
            return [v, k]
        } catch (e) {
            return [null, 0];
        }
    },
    getpt: function(w) {
        try {
            return ptr(eval(w));
        } catch (e) {
            return ptr(0);
        }
    },
    getrange: function(pt) {
        try {
            pt = ptr(pt);
            if (pt === null || pt === ptr(0)) {
                return []
            }
            return Process.findRangeByAddress(ptr(pt));
        } catch (e) {
            return []
        }
    },
    getvar: function(w) {
        return this[w];
    },
    hook: function(w) {
        try {
            var p = ptr(w);
            hooks[p] = {
                'i': Interceptor.attach(p, function () {
                    onHook(p, this.context);
                }),
                'c': null,
                'l': null
            };
            return true;
        } catch (e) {
            return false;
        }
    },
    hookcond: function(pt, w) {
        try {
            pt = ptr(pt);
            var obj = hooks[pt];
            if (typeof obj !== 'undefined' && obj !== null) {
                obj['c'] = w;
                return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    },
    hooklogic: function(pt, w) {
        try {
            pt = ptr(pt);
            var obj = hooks[pt];
            if (typeof obj !== 'undefined' && obj !== null) {
                obj['l'] = new Function(w);
                return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    },
    isvalidptr: function(pt) {
        try {
            var r = Process.findRangeByAddress(ptr(pt));
            return r !== null && typeof r !== 'undefined';
        } catch (e) {
            return false;
        }
    },
    memread: function(w, l) {
        try {
            w = ptr(w);
            return Memory.readByteArray(w, l);
        } catch (e) {
            return [];
        }
    },
    onload: function(m) {
        if (onLoads.indexOf(m) < 0) {
            onLoads.push(m);
        }
    },
    readptr: function(pt) {
        try {
            return Memory.readPointer(ptr(pt));
        } catch (e) {
            return ptr(0x0)
        }
    },
    readu8s: function(pt) {
        try {
            return Memory.readUtf8String(ptr(pt));
        } catch (e) {
            return ''
        }
    },
    release: function (tid) {
        if (typeof tid === 'undefined') {
            for (var t in sleepingThreads) {
                sleepingThreads[t] = false;
            }
        } else {
            var sleepingThread = sleepingThreads[tid];
            if (typeof sleepingThread !== 'undefined') {
                sleepingThread[tid] = false;
            }
        }
    },
    restart: function () {
        Java.perform(function () {
            var Intent = Java.use('android.content.Intent');
            var intent = javaAppContext.getPackageManager().getLaunchIntentForPackage(
                javaAppContext.getPackageName());
            intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP['value']);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK['value']);
            intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK ['value']);
            javaAppContext.startActivity(intent);
        });
    },
    ts: function (p) {
        try {
            var w = Memory.readPointer(ptr(p));
            var r = Process.findRangeByAddress(w);
            if (r !== null) {
                // valid pointer
                return [1, w];
            } else {
                try {
                    var s = Memory.readUtf8String(ptr(p));
                    if (s.length > 1) {
                        // valid string
                        return [0, w + ' (' + s + ')']
                    }
                } catch (e) {
                }
            }
        } catch (e) {
            return [-1, ''];
        }

        // int
        return [2, w];
    }
};